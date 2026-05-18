import { ProviderError, type CompareInput, type FinalizeInput, type GenerateInput, type ModelDriver, type ModelTextResult, type MutateInput } from "@deepthonk/core";
import { resolveProviderConfig } from "./defaults.js";
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

export class OpenAiCompatibleDriver implements ModelDriver {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly httpRetries: number;
  readonly requestTimeoutMs?: number;
  readonly supportsJsonMode: boolean;

  constructor(private readonly config: ProviderConfig) {
    this.provider = config.provider;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
    this.httpRetries = config.retry?.httpRetries ?? 2;
    this.requestTimeoutMs = config.retry?.requestTimeoutMs ?? 120_000;
    this.supportsJsonMode = config.supportsJsonMode ?? true;
    if (!this.apiKey) {
      throw new ProviderError(`Missing API key. Set ${config.apiKeyEnv ?? "apiKey"} for provider ${config.provider}.`, {
        code: "provider.missing_api_key",
        retryable: false,
        fix: `Set ${config.apiKeyEnv ?? "apiKey"} or run deepthonk setup.`
      });
    }
  }

  async generate(input: GenerateInput): Promise<ModelTextResult> {
    return this.chat(input.model, input.temperature, messages(input), false);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    return this.chat(input.model, input.temperature, messages(input), true);
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    return this.chat(input.model, input.temperature, messages(input), false);
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    return this.chat(input.model, 0.2, messages(input), false);
  }

  private async chat(model: string, temperature: number, messagesValue: ChatMessage[], jsonMode: boolean): Promise<ModelTextResult> {
    const started = Date.now();
    let lastError: unknown;
    let retryCount = 0;
    for (let attempt = 0; attempt <= this.httpRetries; attempt += 1) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const body: Record<string, unknown> = {
          model,
          messages: messagesValue,
          temperature,
          max_tokens: 4096
        };
        if (jsonMode && this.supportsJsonMode) body.response_format = { type: "json_object" };
        const controller = this.requestTimeoutMs ? new AbortController() : undefined;
        timeout = controller ? setTimeout(() => controller.abort(), this.requestTimeoutMs) : undefined;
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller?.signal
        });
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        if (!response.ok) {
          const text = await response.text();
          if ((response.status === 429 || response.status >= 500) && attempt < this.httpRetries) {
            retryCount += 1;
            await sleep(retryDelay(response, attempt));
            continue;
          }
          if (jsonMode && this.supportsJsonMode && rejectsJsonMode(response.status, text)) {
            return new OpenAiCompatibleDriver({ ...this.config, supportsJsonMode: false }).chat(model, temperature, messagesValue, false);
          }
          throw providerHttpError(this.provider, response.status);
        }
        const json = (await response.json()) as OpenAiChatResponse;
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
        if (timeout) clearTimeout(timeout);
        lastError = error;
        if (attempt < this.httpRetries && isRetryableError(error)) {
          retryCount += 1;
          await sleep(backoff(attempt));
          continue;
        }
        break;
      }
    }
    if (lastError instanceof ProviderError) throw lastError;
    if (isAbortError(lastError)) {
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
  return status === 400 && /response_format|json/i.test(body);
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

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return backoff(attempt);
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(retryAfter);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return backoff(attempt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function backoff(attempt: number): number {
  return 200 * 2 ** attempt + Math.floor(Math.random() * 50);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
