import { FakeDriver } from "./fake.js";
import { createDeepSeekDriver, OpenAiCompatibleDriver } from "./openaiCompatible.js";
import { ConfigError, ProviderError } from "@deepthonk/core";
import { SamplingDriver } from "./sampling.js";
import type { CompareInput, FinalizeInput, GenerateInput, ModelDriver, MutateInput, ProviderConfig, ProviderRole, RoleProviderConfig } from "./types.js";

export function createDriver(config: ProviderConfig): ModelDriver {
  const baseDriver = createSingleDriver({ ...config, roleProviders: undefined });
  const driver = config.roleProviders ? new RoleRoutingDriver(baseDriver, config.roleProviders) : baseDriver;
  if (config.routeFingerprint) {
    Object.defineProperty(driver, "routeFingerprint", { value: config.routeFingerprint, enumerable: false });
  }
  return driver;
}

/** Route-only driver for validation and dry-run planning; every model method refuses execution. */
export function createDriverIdentity(config: ProviderConfig): ModelDriver {
  const unavailable = async (): Promise<never> => {
    throw new ConfigError("A route-identity driver cannot make model calls.", {
      code: "provider.identity_driver_call",
      retryable: false,
      fix: "Construct a real provider driver before executing the run."
    });
  };
  const identity = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    routeFingerprint: config.routeFingerprint,
    generate: unavailable,
    compare: unavailable,
    mutate: unavailable,
    finalize: unavailable
  } as ModelDriver & {
    provider: string;
    baseUrl?: string;
    routeFingerprint?: string;
    routes?: Partial<Record<ProviderRole, { driver: ModelDriver; model: string }>>;
  };
  if (config.roleProviders) {
    identity.routes = Object.fromEntries(
      Object.entries(config.roleProviders).map(([role, route]) => [
        role,
        {
          driver: {
            provider: route.provider,
            baseUrl: route.baseUrl,
            generate: unavailable,
            compare: unavailable,
            mutate: unavailable,
            finalize: unavailable
          } as ModelDriver,
          model: route.model
        }
      ])
    );
  }
  return identity;
}

function createSingleDriver(config: ProviderConfig): ModelDriver {
  if (config.provider === "fake") return new FakeDriver();
  if (config.provider === "sampling") {
    if (!config.samplingTransport) {
      throw new ConfigError("MCP Sampling provider requires running as an MCP server. Use a direct provider mode (deepseek, openrouter, openai-compatible) for CLI runs.", {
        code: "provider.sampling_requires_mcp",
        retryable: false,
        fix: "Run DeepThonk through an MCP host that advertises sampling, or choose a direct provider for CLI runs."
      });
    }
    return new SamplingDriver(config.samplingTransport, {
      ...config,
      requestTimeoutMs: config.retry?.requestTimeoutMs ?? (config as { requestTimeoutMs?: number }).requestTimeoutMs
    });
  }
  if (config.provider === "deepseek") return createDeepSeekDriver(config);
  if (config.provider === "openai-compatible") return new OpenAiCompatibleDriver(config);
  if (config.baseUrl) return new OpenAiCompatibleDriver(config);
  throw new ProviderError(`Unknown provider: ${config.provider}. Use provider "openai-compatible" or provide baseUrl/apiKeyEnv for OpenAI-compatible providers.`, {
    code: "provider.unknown_provider",
    retryable: false,
    fix: "Set provider to fake, deepseek, openrouter, openai-compatible, or provide baseUrl/apiKeyEnv for a custom OpenAI-compatible provider."
  });
}

class RoleRoutingDriver implements ModelDriver {
  private readonly routes: Partial<Record<ProviderRole, { driver: ModelDriver; model: string }>>;

  constructor(
    private readonly baseDriver: ModelDriver,
    roleProviders: NonNullable<ProviderConfig["roleProviders"]>
  ) {
    this.routes = Object.fromEntries(
      Object.entries(roleProviders).map(([role, roleConfig]) => [role, { driver: createSingleDriver(roleProviderToConfig(roleConfig)), model: roleConfig.model }])
    ) as Partial<Record<ProviderRole, { driver: ModelDriver; model: string }>>;
  }

  generate(input: GenerateInput) {
    return this.route("generator").driver.generate(this.withRouteModel(input, "generator"));
  }

  compare(input: CompareInput) {
    return this.route("judge").driver.compare(this.withRouteModel(input, "judge"));
  }

  mutate(input: MutateInput) {
    return this.route("mutator").driver.mutate(this.withRouteModel(input, "mutator"));
  }

  finalize(input: FinalizeInput) {
    const route = this.route("finalizer");
    if (!route.driver.finalize) return this.baseDriver.finalize?.(input) ?? Promise.resolve({ text: input.candidate.content });
    return route.driver.finalize(this.withRouteModel(input, "finalizer"));
  }

  private route(role: ProviderRole): { driver: ModelDriver; model?: string } {
    return this.routes[role] ?? { driver: this.baseDriver };
  }

  private withRouteModel<T extends { model: string }>(input: T, role: ProviderRole): T {
    const model = this.routes[role]?.model;
    return model ? { ...input, model } : input;
  }
}

function roleProviderToConfig(config: RoleProviderConfig): ProviderConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    apiKey: config.apiKey,
    models: {
      generator: config.model,
      mutator: config.model,
      judge: config.model,
      finalizer: config.model
    },
    providerMaxConcurrency: config.providerMaxConcurrency,
    retry: config.retry,
    supportsJsonMode: config.supportsJsonMode
  };
}
