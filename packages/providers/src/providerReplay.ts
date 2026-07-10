import { createHash } from "node:crypto";
import { ConfigError } from "@deepthonk/core";
import { z } from "zod";
import { resolveProviderConfig } from "./defaults.js";
import type { ProviderConfig, ProviderRole } from "./types.js";

const providerRoles = ["generator", "mutator", "judge", "finalizer"] as const satisfies readonly ProviderRole[];

const providerReplayRoleSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string().min(1),
  supportsJsonMode: z.boolean().optional()
}).strict();

export const providerReplaySchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  supportsJsonMode: z.boolean().default(true),
  models: z.object({
    generator: z.string().min(1),
    mutator: z.string().min(1),
    judge: z.string().min(1),
    finalizer: z.string().min(1).optional()
  }).strict(),
  roleProviders: z
    .object({
      generator: providerReplayRoleSchema.optional(),
      mutator: providerReplayRoleSchema.optional(),
      judge: providerReplayRoleSchema.optional(),
      finalizer: providerReplayRoleSchema.optional()
    })
    .strict()
    .optional(),
  samplingPreferences: z
    .object({
      modelHints: z.array(z.string().min(1)).optional(),
      costPriority: z.number().min(0).max(1).optional(),
      speedPriority: z.number().min(0).max(1).optional(),
      intelligencePriority: z.number().min(0).max(1).optional()
    })
    .strict()
    .optional(),
  routeFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
}).strict();

export type ProviderReplay = z.infer<typeof providerReplaySchema>;

export function providerReplayFromConfig(config: ProviderConfig): ProviderReplay {
  const replay: ProviderReplay = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    supportsJsonMode: config.supportsJsonMode ?? true,
    models: compactObject({
      generator: config.models.generator,
      mutator: config.models.mutator,
      judge: config.models.judge,
      finalizer: config.models.finalizer
    }) as ProviderReplay["models"]
  };
  const roleProviders = replayRoleProviders(config);
  if (roleProviders) replay.roleProviders = roleProviders;
  const samplingPreferences = compactObject({
    modelHints: config.modelHints,
    costPriority: config.costPriority,
    speedPriority: config.speedPriority,
    intelligencePriority: config.intelligencePriority
  });
  if (Object.keys(samplingPreferences).length > 0) {
    replay.samplingPreferences = samplingPreferences as ProviderReplay["samplingPreferences"];
  }
  replay.routeFingerprint = providerRouteFingerprint(replay);
  return replay;
}

export function parseProviderReplay(value: unknown): ProviderReplay | undefined {
  if (value === undefined) return undefined;
  const parsed = providerReplaySchema.safeParse(value);
  if (!parsed.success) {
    throw invalidReplay(`Stored provider replay is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`);
  }
  assertProviderReplayFingerprint(parsed.data);
  return parsed.data;
}

export function providerConfigFromReplay(
  replay: ProviderReplay,
  retry?: ProviderConfig["retry"],
  options: { providerMaxConcurrency?: number; samplingTransport?: ProviderConfig["samplingTransport"] } = {}
): ProviderConfig {
  assertProviderReplayFingerprint(replay);
  return resolveProviderConfig({
    provider: replay.provider,
    routeFingerprint: replay.routeFingerprint,
    providerMaxConcurrency: options.providerMaxConcurrency,
    baseUrl: replay.baseUrl,
    apiKeyEnv: replay.apiKeyEnv,
    supportsJsonMode: replay.supportsJsonMode,
    models: replay.models,
    roleProviders: replay.roleProviders,
    retry,
    samplingTransport: options.samplingTransport,
    modelHints: replay.samplingPreferences?.modelHints,
    costPriority: replay.samplingPreferences?.costPriority,
    speedPriority: replay.samplingPreferences?.speedPriority,
    intelligencePriority: replay.samplingPreferences?.intelligencePriority
  });
}

export function providerRouteFingerprint(replay: Omit<ProviderReplay, "routeFingerprint"> | ProviderReplay): string {
  const roles = Object.fromEntries(
    providerRoles.flatMap((role) => {
      const route = replay.roleProviders?.[role];
      return route
        ? [[role, routeFingerprintValue(route.provider, route.baseUrl, route.apiKeyEnv, route.model, route.supportsJsonMode)] as const]
        : [];
    })
  );
  const fingerprintValue = {
    base: routeFingerprintValue(replay.provider, replay.baseUrl, replay.apiKeyEnv, replay.models, replay.supportsJsonMode),
    roles,
    samplingPreferences: replay.samplingPreferences ?? null
  };
  return `sha256:${createHash("sha256").update(stableJson(fingerprintValue)).digest("hex")}`;
}

export function assertProviderReplayFingerprint(replay: ProviderReplay): void {
  if (replay.routeFingerprint && replay.routeFingerprint !== providerRouteFingerprint(replay)) {
    throw invalidReplay("Stored provider replay route fingerprint does not match its provider route fields.");
  }
}

function replayRoleProviders(config: ProviderConfig): ProviderReplay["roleProviders"] | undefined {
  if (!config.roleProviders) return undefined;
  const entries = providerRoles.flatMap((role) => {
    const roleConfig = config.roleProviders?.[role];
    if (!roleConfig) return [];
    return [
      [
        role,
        compactObject({
          provider: roleConfig.provider,
          baseUrl: roleConfig.baseUrl,
          apiKeyEnv: roleConfig.apiKeyEnv,
          model: roleConfig.model,
          supportsJsonMode: roleConfig.supportsJsonMode
        })
      ] as const
    ];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as Partial<T>;
}

function routeFingerprintValue(
  provider: string,
  baseUrl: string | undefined,
  apiKeyEnv: string | undefined,
  model: string | ProviderReplay["models"],
  supportsJsonMode: boolean | undefined
): Record<string, unknown> {
  return compactObject({
    provider,
    baseUrl: normalizeFingerprintUrl(baseUrl),
    apiKeyEnv,
    model,
    supportsJsonMode
  });
}

function normalizeFingerprintUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function invalidReplay(message: string): ConfigError {
  return new ConfigError(message, {
    code: "provider.replay_route_mismatch",
    retryable: false,
    fix: "Resume with the original provider route, or explicitly select a complete replacement route instead of editing config.json."
  });
}
