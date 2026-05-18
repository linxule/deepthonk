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
    return this.sample(input.model, input.temperature, promptMessages(input.prompt));
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    const result = await this.sample(input.model, input.temperature, promptMessages(input.prompt));
    return { ...result, text: extractJsonTextOrOriginal(result.text) };
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    return this.sample(input.model, input.temperature, promptMessages(input.prompt));
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    return this.sample(input.model, 0.2, promptMessages(input.prompt));
  }

  private async sample(model: string, temperature: number, prompt: PromptMessages): Promise<ModelTextResult> {
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
      maxTokens: 4096
    });
    if (result.stopReason === "maxTokens") {
      throw new ProviderError("MCP Sampling response was truncated by maxTokens.", {
        code: "provider.output_truncated",
        retryable: false,
        fix: "Use a smaller prompt, a host model with larger output support, or reduce answer length."
      });
    }
    const text = textContent(result);
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

  private async callCreateMessage(params: CreateMessageRequestParamsBase): Promise<CreateMessageResult> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
    try {
      return await callWithTimeout(this.createMessage, params, timeoutMs);
    } catch (error) {
      if (error instanceof SamplingTimeoutError) {
        throw new ProviderError(`MCP Sampling request timed out after ${error.timeoutMs}ms.`, {
          code: "provider.sampling_timeout",
          retryable: false,
          fix: "Increase retry.requestTimeoutMs, switch to a direct provider, or check the MCP host responsiveness. Use 'deepthonk resume <run-dir> --continue' to retry an interrupted run."
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
  timeoutMs: number
): Promise<CreateMessageResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SamplingTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(params, { signal: controller.signal, timeout: timeoutMs }), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
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
