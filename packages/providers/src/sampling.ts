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

export interface SamplingDriverConfig {
  modelHints?: string[];
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
  includeRawOutputs?: boolean;
  requestTimeoutMs?: number;
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
  readonly maxConcurrency = 4;

  constructor(
    private readonly createMessage: SamplingTransport,
    private readonly config: SamplingDriverConfig = {}
  ) {}

  async generate(input: GenerateInput): Promise<ModelTextResult> {
    const controls = requestControls(input);
    return this.sample(input.model, input.temperature, promptMessages(input.prompt), controls.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, controls.signal);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    const controls = requestControls(input);
    const result = await this.sample(input.model, input.temperature, promptMessages(input.prompt), controls.maxOutputTokens ?? DEFAULT_JUDGE_OUTPUT_TOKENS, controls.signal);
    return { ...result, text: extractJsonTextOrOriginal(result.text) };
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    const controls = requestControls(input);
    return this.sample(input.model, input.temperature, promptMessages(input.prompt), controls.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, controls.signal);
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    const controls = requestControls(input);
    return this.sample(input.model, 0.2, promptMessages(input.prompt), controls.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, controls.signal);
  }

  private async sample(
    model: string,
    temperature: number,
    prompt: PromptMessages,
    maxOutputTokens: number,
    signal?: AbortSignal
  ): Promise<ModelTextResult> {
    const started = Date.now();
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
    }, signal);
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
  }

  private async callCreateMessage(params: CreateMessageRequestParamsBase, signal?: AbortSignal): Promise<CreateMessageResult> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
    try {
      return await callWithTimeout(this.createMessage, params, timeoutMs, signal);
    } catch (error) {
      if (error instanceof SamplingTimeoutError) {
        throw new ProviderError(`MCP Sampling request timed out after ${error.timeoutMs}ms.`, {
          code: "provider.sampling_timeout",
          retryable: false,
          fix: "Increase retry.requestTimeoutMs, switch to a direct provider, or check the MCP host responsiveness. Use 'deepthonk resume <run-dir> --continue' to retry an interrupted run."
        });
      }
      if (signal?.aborted) {
        throw new ProviderError("MCP Sampling request was aborted.", {
          code: "provider.aborted",
          retryable: false,
          fix: "Retry the run if the cancellation was unintended."
        });
      }
      throw new ProviderError(`MCP Sampling request failed: ${error instanceof Error ? error.message : String(error)}`, {
        code: "provider.sampling_request_failed",
        retryable: false,
        fix: "The MCP host refused or errored the sampling request. Use 'deepthonk resume <run-dir> --continue' to retry an interrupted run, or switch to a direct provider."
      });
    }
  }
}

class SamplingTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`MCP Sampling request timed out after ${timeoutMs}ms.`);
    this.name = "SamplingTimeoutError";
  }
}

async function callWithTimeout(
  fn: SamplingTransport,
  params: CreateMessageRequestParamsBase,
  timeoutMs: number,
  inputSignal?: AbortSignal
): Promise<CreateMessageResult> {
  const controller = new AbortController();
  const onInputAbort = () => controller.abort(inputSignal?.reason);
  if (inputSignal?.aborted) controller.abort(inputSignal.reason);
  else inputSignal?.addEventListener("abort", onInputAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SamplingTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  let rejectOnAbort: (() => void) | undefined;
  const abortPromise = inputSignal
    ? new Promise<never>((_, reject) => {
        if (inputSignal.aborted) {
          reject(inputSignal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        rejectOnAbort = () => reject(inputSignal.reason ?? new DOMException("Aborted", "AbortError"));
        inputSignal.addEventListener("abort", rejectOnAbort, { once: true });
      })
    : undefined;
  try {
    return await Promise.race([
      fn(params, { signal: controller.signal, timeout: timeoutMs }),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : [])
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    inputSignal?.removeEventListener("abort", onInputAbort);
    if (rejectOnAbort) inputSignal?.removeEventListener("abort", rejectOnAbort);
  }
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

function requestControls(input: unknown): { maxOutputTokens?: number; signal?: AbortSignal } {
  return input as { maxOutputTokens?: number; signal?: AbortSignal };
}
