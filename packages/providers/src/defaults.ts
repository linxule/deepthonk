import type { SamplingTransport } from "./sampling.js";
import type { ProviderConfig, ProviderRole, RoleProviderConfig } from "./types.js";

export type DirectProviderName = "fake" | "openai-compatible" | "deepseek" | "openrouter";

export interface ProviderModelOverrides {
  generator?: string;
  mutator?: string;
  judge?: string;
  finalizer?: string;
}

export interface ProviderConfigOptions {
  provider: string;
  routeFingerprint?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  models?: ProviderModelOverrides;
  retry?: ProviderConfig["retry"];
  supportsJsonMode?: boolean;
  samplingTransport?: SamplingTransport;
  modelHints?: string[];
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
  includeRawOutputs?: boolean;
  requestTimeoutMs?: number;
  /** Disable implicit endpoint and credential defaults for an explicitly replaced route. */
  inheritProviderDefaults?: boolean;
  roleProviders?: Partial<Record<ProviderRole, Partial<Omit<RoleProviderConfig, "model">> & { model?: string }>>;
}

export function resolveProviderModels(provider: string, overrides: ProviderModelOverrides = {}): ProviderConfig["models"] {
  return {
    generator: overrides.generator ?? defaultModel(provider, "generator"),
    mutator: overrides.mutator ?? defaultModel(provider, "mutator"),
    judge: overrides.judge ?? defaultModel(provider, "judge"),
    finalizer: overrides.finalizer
  };
}

export function resolveProviderConfig(options: ProviderConfigOptions): ProviderConfig {
  const models = resolveProviderModels(options.provider, options.models);
  const inheritProviderDefaults = options.inheritProviderDefaults ?? true;
  return {
    provider: options.provider,
    routeFingerprint: options.routeFingerprint,
    baseUrl: options.baseUrl ?? (inheritProviderDefaults ? defaultBaseUrl(options.provider) : undefined),
    apiKeyEnv: options.apiKeyEnv ?? (inheritProviderDefaults ? defaultApiKeyEnv(options.provider) : undefined),
    apiKey: options.apiKey,
    models,
    retry: options.retry,
    supportsJsonMode: options.supportsJsonMode,
    samplingTransport: options.samplingTransport,
    modelHints: options.modelHints,
    costPriority: options.costPriority,
    speedPriority: options.speedPriority,
    intelligencePriority: options.intelligencePriority,
    includeRawOutputs: options.includeRawOutputs,
    requestTimeoutMs: options.requestTimeoutMs,
    roleProviders: resolveRoleProviders(options.provider, models, options.roleProviders, options.retry, options.supportsJsonMode)
  };
}

export function defaultModel(provider: string, role: ProviderRole): string {
  if (role === "finalizer") return defaultModel(provider, "judge");
  if (provider === "deepseek") return role === "judge" ? "deepseek-v4-pro" : "deepseek-v4-flash";
  if (provider === "fake") return "fake-model";
  if (provider === "sampling") return "sampling";
  if (provider === "openrouter") return "openrouter/auto";
  return role === "judge" ? "provider/model-large" : "provider/model-small";
}

export function defaultBaseUrl(provider: string): string | undefined {
  if (provider === "deepseek") return "https://api.deepseek.com/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return undefined;
}

export function defaultApiKeyEnv(provider: string): string | undefined {
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "openai-compatible") return "DEEPTHONK_API_KEY";
  return undefined;
}

function resolveRoleProviders(
  baseProvider: string,
  models: ProviderConfig["models"],
  roleProviders?: ProviderConfigOptions["roleProviders"],
  baseRetry?: ProviderConfig["retry"],
  baseSupportsJsonMode?: boolean
): ProviderConfig["roleProviders"] {
  if (!roleProviders) return undefined;
  const resolved: ProviderConfig["roleProviders"] = {};
  for (const role of ["generator", "mutator", "judge", "finalizer"] as const) {
    const input = roleProviders[role];
    if (!input) continue;
    const provider = input.provider ?? baseProvider;
    const isolatedRoute =
      input.baseUrl !== undefined || (input.provider !== undefined && input.provider !== baseProvider);
    const model = input.model ?? (isolatedRoute ? defaultModel(provider, role) : models[role]) ?? defaultModel(provider, role);
    resolved[role] = {
      provider,
      baseUrl: input.baseUrl ?? defaultBaseUrl(provider),
      apiKeyEnv: input.apiKeyEnv ?? (input.baseUrl === undefined ? defaultApiKeyEnv(provider) : undefined),
      apiKey: input.apiKey,
      model,
      retry: input.retry ?? baseRetry,
      supportsJsonMode: input.supportsJsonMode ?? (isolatedRoute ? undefined : baseSupportsJsonMode)
    };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}
