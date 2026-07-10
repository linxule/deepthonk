import {
  ProviderError,
  type CompareInput,
  type FinalizeInput,
  type GenerateInput,
  type ModelDriver,
  type ModelTextResult,
  type MutateInput,
  type PromptMessages
} from "@deepthonk/core";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CreateMessageRequestParamsBase, CreateMessageResult, ModelPreferences } from "@modelcontextprotocol/sdk/types.js";
import { extractJsonObjectText } from "./jsonExtract.js";
import { getSharedRouteLimiter, type AdaptiveRouteLimiter } from "./routeLimiter.js";
import type { ProviderConfig } from "./types.js";

export interface SamplingDriverConfig {
  modelHints?: string[];
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
  includeRawOutputs?: boolean;
  requestTimeoutMs?: number;
  providerMaxConcurrency?: number;
}

const DEFAULT_SAMPLING_TIMEOUT_MS = 60_000;
const DEFAULT_SAMPLING_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_TOKENS = 4096;
const DEFAULT_JUDGE_OUTPUT_TOKENS = 1024;

export type SamplingTransport = (
  params: CreateMessageRequestParamsBase,
  options?: RequestOptions
) => Promise<CreateMessageResult>;

export class SamplingDriver implements ModelDriver {
  private readonly routeLimiter: AdaptiveRouteLimiter;

  constructor(
    private readonly createMessage: SamplingTransport,
    private readonly config: SamplingDriverConfig = {}
  ) {
    this.routeLimiter = getSharedRouteLimiter({
      provider: "sampling",
      models: { generator: "sampling", mutator: "sampling", judge: "sampling" },
      providerMaxConcurrency: config.providerMaxConcurrency
    } as ProviderConfig);
  }

  async generate(input: GenerateInput): Promise<ModelTextResult> {
    return this.sample(input.model, input.temperature, promptMessages(input.prompt), input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, input.signal);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    const result = await this.sample(input.model, input.temperature, promptMessages(input.prompt), input.maxOutputTokens ?? DEFAULT_JUDGE_OUTPUT_TOKENS, input.signal);
    return { ...result, text: extractJsonTextOrOriginal(result.text) };
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    return this.sample(input.model, input.temperature, promptMessages(input.prompt), input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, input.signal);
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    return this.sample(input.model, 0.2, promptMessages(input.prompt), input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, input.signal);
  }

  private async sample(
    model: string,
    temperature: number,
    prompt: PromptMessages,
    maxOutputTokens: number,
    signal?: AbortSignal
  ): Promise<ModelTextResult> {
    const started = Date.now();
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
    const deadline = samplingDeadline(timeoutMs, signal);
    let release: (() => void) | undefined;
    try {
      release = await this.routeLimiter.acquire(deadline.signal);
      const result = await this.callCreateMessage({
        messages: prompt.user.trim()
          ? [
              {
                role: "user",
                content: {
                  type: "text",
                  text: prompt.user
                }
              }
            ]
          : [],
        systemPrompt: prompt.system.trim() ? prompt.system : undefined,
        modelPreferences: buildModelPreferences(model, this.config),
        includeContext: "none",
        temperature,
        maxTokens: maxOutputTokens
      }, deadline);
      if (result.stopReason === "maxTokens") {
        throw new ProviderError("MCP Sampling response was truncated by maxTokens.", {
          code: "provider.output_truncated",
          retryable: false,
          fix: "Use a smaller prompt, a host model with larger output support, or reduce answer length."
        });
      }
      const text = textContent(result);
      if (Buffer.byteLength(text, "utf8") > DEFAULT_SAMPLING_RESPONSE_LIMIT_BYTES) {
        throw new ProviderError(`MCP Sampling response exceeded the ${DEFAULT_SAMPLING_RESPONSE_LIMIT_BYTES}-byte body limit.`, {
          code: "provider.response_too_large",
          retryable: false,
          fix: "Use a host model with bounded text responses or reduce the requested output size."
        });
      }
      this.routeLimiter.recordSuccess();
      return {
        text,
        model: result.model ?? model,
        provider: "sampling",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined
        },
        latencyMs: Date.now() - started,
        retryCount: 0,
        raw: this.config.includeRawOutputs ? result : undefined
      };
    } catch (error) {
      if (isRateLimitError(error)) this.routeLimiter.recordRateLimit();
      if (deadline.timedOut()) throw samplingTimeoutError(timeoutMs);
      if (signal?.aborted) {
        throw new ProviderError("MCP Sampling request was aborted.", {
          code: "provider.aborted",
          retryable: false,
          fix: "Retry the run if the cancellation was unintended."
        });
      }
      throw error;
    } finally {
      release?.();
      deadline.dispose();
    }
  }

  private async callCreateMessage(params: CreateMessageRequestParamsBase, deadline: SamplingDeadline): Promise<CreateMessageResult> {
    try {
      return await callWithDeadline(this.createMessage, params, deadline);
    } catch (error) {
      if (deadline.signal.aborted) throw error;
      throw new ProviderError(`MCP Sampling request failed: ${error instanceof Error ? error.message : String(error)}`, {
        code: "provider.sampling_request_failed",
        retryable: false,
        fix: "The MCP host refused or errored the sampling request. Use 'deepthonk resume <run-dir> --continue' to retry an interrupted run, or switch to a direct provider."
      });
    }
  }
}

interface SamplingDeadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  remainingMs: () => number;
  dispose: () => void;
}

async function callWithDeadline(
  fn: SamplingTransport,
  params: CreateMessageRequestParamsBase,
  deadline: SamplingDeadline
): Promise<CreateMessageResult> {
  if (deadline.signal.aborted) throw abortError(deadline.signal);
  let rejectOnAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(abortError(deadline.signal));
    deadline.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([
      fn(params, { signal: deadline.signal, timeout: Math.max(1, deadline.remainingMs()) }),
      abortPromise
    ]);
  } finally {
    if (rejectOnAbort) deadline.signal.removeEventListener("abort", rejectOnAbort);
  }
}

function samplingDeadline(timeoutMs: number, inputSignal?: AbortSignal): SamplingDeadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  let timeoutReached = false;
  const onInputAbort = () => controller.abort(inputSignal?.reason);
  if (inputSignal?.aborted) controller.abort(inputSignal.reason);
  else inputSignal?.addEventListener("abort", onInputAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new DOMException("Timed out", "AbortError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    remainingMs: () => Math.max(0, expiresAt - Date.now()),
    dispose: () => {
      clearTimeout(timer);
      inputSignal?.removeEventListener("abort", onInputAbort);
    }
  };
}

function samplingTimeoutError(timeoutMs: number): ProviderError {
  return new ProviderError(`MCP Sampling request timed out after ${timeoutMs}ms.`, {
    code: "provider.sampling_timeout",
    retryable: false,
    fix: "Increase retry.requestTimeoutMs, switch to a direct provider, or check the MCP host responsiveness. Use 'deepthonk resume <run-dir> --continue' to retry an interrupted run."
  });
}

function abortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException ? signal.reason : new DOMException("Aborted", "AbortError");
}

export function buildModelPreferences(roleModel: string | undefined, config: SamplingDriverConfig): ModelPreferences | undefined {
  const hintNames = uniqueNonEmpty([roleModel, ...(config.modelHints ?? [])]);
  const preferences: ModelPreferences = {};
  if (hintNames.length > 0) preferences.hints = hintNames.map((name) => ({ name }));
  if (config.costPriority !== undefined) preferences.costPriority = config.costPriority;
  if (config.speedPriority !== undefined) preferences.speedPriority = config.speedPriority;
  if (config.intelligencePriority !== undefined) preferences.intelligencePriority = config.intelligencePriority;
  return Object.keys(preferences).length > 0 ? preferences : undefined;
}

function promptMessages(prompt: PromptMessages | undefined): PromptMessages {
  if (!prompt) throw new ProviderError("Core did not provide prompt messages.");
  return prompt;
}

function textContent(result: CreateMessageResult): string {
  if (result.content.type === "text") return result.content.text;
  throw new ProviderError(`MCP Sampling returned unsupported ${result.content.type} content.`, {
    code: "provider.sampling_non_text_response",
    retryable: false,
    fix: "Use an MCP client/model that can return text content for sampling requests."
  });
}

function extractJsonTextOrOriginal(text: string): string {
  try {
    return extractJsonObjectText(text);
  } catch {
    return text;
  }
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit/i.test(message);
}
