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
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  models?: ProviderModelOverrides;
  retry?: ProviderConfig["retry"];
  supportsJsonMode?: boolean;
  samplingTransport?: SamplingTransport;
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
  return {
    provider: options.provider,
    baseUrl: options.baseUrl ?? defaultBaseUrl(options.provider),
    apiKeyEnv: options.apiKeyEnv ?? defaultApiKeyEnv(options.provider),
    apiKey: options.apiKey,
    models,
    retry: options.retry,
    supportsJsonMode: options.supportsJsonMode,
    samplingTransport: options.samplingTransport,
    roleProviders: resolveRoleProviders(options.provider, models, options.roleProviders, options.retry)
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
  baseRetry?: ProviderConfig["retry"]
): ProviderConfig["roleProviders"] {
  if (!roleProviders) return undefined;
  const resolved: ProviderConfig["roleProviders"] = {};
  for (const role of ["generator", "mutator", "judge", "finalizer"] as const) {
    const input = roleProviders[role];
    if (!input) continue;
    const provider = input.provider ?? baseProvider;
    const model = input.model ?? models[role] ?? defaultModel(provider, role);
    resolved[role] = {
      provider,
      baseUrl: input.baseUrl ?? defaultBaseUrl(provider),
      apiKeyEnv: input.apiKeyEnv ?? defaultApiKeyEnv(provider),
      apiKey: input.apiKey,
      model,
      retry: input.retry ?? baseRetry,
      supportsJsonMode: input.supportsJsonMode
    };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}
