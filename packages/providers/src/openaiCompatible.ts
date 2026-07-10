import { ProviderError, type CompareInput, type FinalizeInput, type GenerateInput, type ModelDriver, type ModelTextResult, type MutateInput } from "@deepthonk/core";
import { resolveProviderConfig } from "./defaults.js";
import { getSharedRouteLimiter, type AdaptiveRouteLimiter } from "./routeLimiter.js";
import type { ProviderConfig } from "./types.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_OUTPUT_TOKENS = 4096;
const DEFAULT_JUDGE_OUTPUT_TOKENS = 1024;

export class OpenAiCompatibleDriver implements ModelDriver {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly httpRetries: number;
  readonly requestTimeoutMs?: number;
  readonly responseBodyLimitBytes: number;
  readonly maxRetryDelayMs: number;
  readonly supportsJsonMode: boolean;
  private jsonModeState: "unknown" | "supported" | "unsupported";
  private jsonModeProbe?: Promise<ModelTextResult>;
  private readonly routeLimiter: AdaptiveRouteLimiter;

  constructor(private readonly config: ProviderConfig) {
    this.provider = config.provider;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
    this.httpRetries = config.retry?.httpRetries ?? 12;
    this.requestTimeoutMs = config.retry?.requestTimeoutMs ?? 120_000;
    this.responseBodyLimitBytes = config.retry?.responseBodyLimitBytes ?? DEFAULT_RESPONSE_BODY_LIMIT_BYTES;
    this.maxRetryDelayMs = Math.min(config.retry?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS, DEFAULT_MAX_RETRY_DELAY_MS);
    this.supportsJsonMode = config.supportsJsonMode ?? true;
    this.jsonModeState = this.supportsJsonMode ? "unknown" : "unsupported";
    this.routeLimiter = getSharedRouteLimiter(config);
    if (!this.apiKey) {
      throw new ProviderError(`Missing API key. Set ${config.apiKeyEnv ?? "apiKey"} for provider ${config.provider}.`, {
        code: "provider.missing_api_key",
        retryable: false,
        fix: `Set ${config.apiKeyEnv ?? "apiKey"} or run deepthonk setup.`
      });
    }
  }

  async generate(input: GenerateInput): Promise<ModelTextResult> {
    return this.chat(input.model, input.temperature, messages(input), false, input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, input.signal);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    const request = () =>
      this.chat(
        input.model,
        input.temperature,
        messages(input),
        this.jsonModeState !== "unsupported",
        input.maxOutputTokens ?? DEFAULT_JUDGE_OUTPUT_TOKENS,
        input.signal
      );
    if (this.jsonModeState !== "unknown") return request();
    if (!this.jsonModeProbe) {
      const probe = request().then((result) => {
        if (this.jsonModeState === "unknown") this.jsonModeState = "supported";
        return result;
      });
      this.jsonModeProbe = probe;
      void probe.finally(() => {
        if (this.jsonModeProbe === probe) this.jsonModeProbe = undefined;
      }).catch(() => undefined);
      return probe;
    }
    try {
      await this.jsonModeProbe;
    } catch {
      // The next waiter becomes the coordinated probe if the first call failed before
      // determining JSON-mode support.
    }
    return this.compare(input);
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    return this.chat(input.model, input.temperature, messages(input), false, input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, input.signal);
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    return this.chat(input.model, 0.2, messages(input), false, input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, input.signal);
  }

  private async chat(
    model: string,
    temperature: number,
    messagesValue: ChatMessage[],
    jsonMode: boolean,
    maxOutputTokens: number,
    inputSignal?: AbortSignal
  ): Promise<ModelTextResult> {
    const started = Date.now();
    let lastError: unknown;
    let retryCount = 0;
    let retryAttempt = 0;
    let useJsonMode = jsonMode;
    const deadline = deadlineSignal(this.requestTimeoutMs, inputSignal);
    try {
      while (true) {
        let release: (() => void) | undefined;
        try {
          release = await this.routeLimiter.acquire(deadline.signal);
          const body: Record<string, unknown> = {
            model,
            messages: messagesValue,
            temperature,
            max_tokens: maxOutputTokens
          };
          if (useJsonMode) body.response_format = { type: "json_object" };
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body),
            signal: deadline.signal
          });
          if (!response.ok) {
            const text = await readBoundedBody(response, this.responseBodyLimitBytes, deadline.signal);
            if (response.status === 429) this.routeLimiter.recordRateLimit();
            if ((response.status === 429 || response.status >= 500) && retryAttempt < this.httpRetries) {
              retryCount += 1;
              const delay = retryDelay(response, retryAttempt, this.maxRetryDelayMs);
              retryAttempt += 1;
              release();
              release = undefined;
              await sleep(delay, deadline.signal);
              continue;
            }
            if (useJsonMode && rejectsJsonMode(response.status, text)) {
              this.jsonModeState = "unsupported";
              useJsonMode = false;
              retryCount += 1;
              release();
              release = undefined;
              continue;
            }
            throw providerHttpError(this.provider, response.status);
          }
          const responseText = await readBoundedBody(response, this.responseBodyLimitBytes, deadline.signal);
          let json: OpenAiChatResponse;
          try {
            json = JSON.parse(responseText) as OpenAiChatResponse;
          } catch {
            throw new ProviderError("Provider response was not valid JSON.", {
              code: "provider.invalid_response_json",
              retryable: false,
              fix: "Check that the configured endpoint implements OpenAI-compatible chat completions."
            });
          }
          const choice = json.choices?.[0];
          if (choice?.finish_reason === "length") {
            throw new ProviderError("Provider response was truncated by max_tokens.", {
              code: "provider.output_truncated",
              retryable: false,
              fix: "Use a model/provider with shorter outputs or increase max output token support in provider config."
            });
          }
          const text = choice?.message?.content;
          if (!text) throw new ProviderError("Provider response did not include choices[0].message.content.", { code: "provider.empty_response" });
          this.routeLimiter.recordSuccess();
          return {
            text,
            model: json.model ?? model,
            provider: this.provider,
            usage: {
              inputTokens: json.usage?.prompt_tokens,
              inputCacheHitTokens: json.usage?.prompt_cache_hit_tokens,
              inputCacheMissTokens: json.usage?.prompt_cache_miss_tokens,
              outputTokens: json.usage?.completion_tokens,
              totalTokens: json.usage?.total_tokens
            },
            latencyMs: Date.now() - started,
            retryCount,
            raw: json
          };
        } catch (error) {
          lastError = error;
          release?.();
          release = undefined;
          if (!deadline.signal.aborted && retryAttempt < this.httpRetries && isRetryableError(error)) {
            retryCount += 1;
            const delay = backoff(retryAttempt, this.maxRetryDelayMs);
            retryAttempt += 1;
            try {
              await sleep(delay, deadline.signal);
            } catch (sleepError) {
              lastError = sleepError;
              break;
            }
            continue;
          }
          break;
        } finally {
          release?.();
        }
      }
    } finally {
      deadline.dispose();
    }
    if (lastError instanceof ProviderError) throw lastError;
    if (inputSignal?.aborted) {
      throw new ProviderError("Provider request was aborted.", {
        code: "provider.aborted",
        retryable: false,
        fix: "Retry the run if the cancellation was unintended."
      });
    }
    if (isAbortError(lastError) || deadline.timedOut()) {
      throw new ProviderError(`Provider request timed out after ${this.requestTimeoutMs}ms.`, {
        code: "provider.timeout",
        retryable: true,
        fix: "Raise requestTimeoutMs or use a faster model/provider."
      });
    }
    throw new ProviderError(`Provider request failed: ${(lastError as Error).message}`, {
      code: "provider.request_failed",
      retryable: true,
      fix: "Check provider availability, base URL, and network connectivity."
    });
  }
}

export function createDeepSeekDriver(config: Partial<ProviderConfig> = {}): OpenAiCompatibleDriver {
  return new OpenAiCompatibleDriver(resolveProviderConfig({
    provider: "deepseek",
    ...config
  }));
}

function messages(input: GenerateInput | CompareInput | MutateInput | FinalizeInput): ChatMessage[] {
  if (!input.prompt) throw new ProviderError("Core did not provide prompt messages.");
  const chatMessages: ChatMessage[] = [
    { role: "system", content: input.prompt.system },
    { role: "user", content: input.prompt.user }
  ];
  return chatMessages.filter((message) => message.content.trim().length > 0);
}

function normalizeBaseUrl(baseUrl?: string): string {
  if (!baseUrl) {
    throw new ProviderError("OpenAI-compatible provider requires baseUrl.", {
      code: "provider.missing_base_url",
      retryable: false,
      fix: "Set base_url in config or pass --base-url."
    });
  }
  return baseUrl.replace(/\/+$/, "");
}

function rejectsJsonMode(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /response_format|json/i.test(body);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  return true;
}

function providerHttpError(provider: string, status: number): ProviderError {
  const retryable = status === 429 || status >= 500;
  return new ProviderError(`Provider HTTP ${status} from ${provider}.`, {
    code: `provider.http_${status}`,
    retryable,
    fix: retryable ? "Retry later or lower concurrency." : "Check provider configuration, request shape, and model access."
  });
}

function retryDelay(response: Response, attempt: number, maxDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return backoff(attempt, maxDelayMs);
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(maxDelayMs, Math.max(0, seconds * 1000));
  const timestamp = Date.parse(retryAfter);
  if (Number.isFinite(timestamp)) return Math.min(maxDelayMs, Math.max(0, timestamp - Date.now()));
  return backoff(attempt, maxDelayMs);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function backoff(attempt: number, maxDelayMs = DEFAULT_MAX_RETRY_DELAY_MS): number {
  // Multiplicative jitter (±20% around the capped exponential base) matches the reference
  // Python's burst dispersion. Additive jitter at the 60s cap was effectively ±0.4% and would
  // align concurrent retries into the next provider rate-limit window.
  const base = Math.min(maxDelayMs, 500 * 2 ** attempt);
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.min(maxDelayMs, Math.floor(base * jitterFactor));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBoundedBody(response: Response, limitBytes: number, signal?: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) throw responseTooLarge(limitBytes);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw responseTooLarge(limitBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function responseTooLarge(limitBytes: number): ProviderError {
  return new ProviderError(`Provider response exceeded the ${limitBytes}-byte body limit.`, {
    code: "provider.response_too_large",
    retryable: false,
    fix: "Use a provider that returns bounded chat completion responses or reduce the requested output size."
  });
}

function deadlineSignal(timeoutMs: number | undefined, inputSignal?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const onInputAbort = () => controller.abort(inputSignal?.reason);
  if (inputSignal?.aborted) controller.abort(inputSignal.reason);
  else inputSignal?.addEventListener("abort", onInputAbort, { once: true });
  const timer = timeoutMs
    ? setTimeout(() => {
        timeoutReached = true;
        controller.abort(abortError());
      }, timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      if (timer) clearTimeout(timer);
      inputSignal?.removeEventListener("abort", onInputAbort);
    }
  };
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}
