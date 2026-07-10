import { ConfigError, maxPhaseConcurrency, type BuiltInProfileName, type RunConfig } from "@deepthonk/core";
import { z } from "zod";
import type { ProviderRole } from "./types.js";

export interface ExternalConfigFile {
  runId?: string;
  profile?: BuiltInProfileName;
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  supports_json_mode?: boolean;
  models?: { generator?: string; mutator?: string; judge?: string; finalizer?: string };
  providers?: Partial<Record<ProviderRole, ExternalRoleProviderConfig>>;
  concurrency?: Partial<RunConfig["concurrency"]>;
  retry?: Partial<RunConfig["retry"]>;
  budget?: RunConfig["budget"];
  output?: Partial<RunConfig["output"]>;
  prompt_style?: RunConfig["promptStyle"];
  algorithm?: ExternalAlgorithmOverrides;
  prompts?: ExternalPromptOverrides;
  modelOutputTokens?: RunConfig["modelOutputTokens"];
  critiqueLimits?: RunConfig["critiqueLimits"];
  rank?: RunConfig["rank"];
  providerMaxConcurrency?: number;
  metadata?: Record<string, unknown>;
}

export interface ExternalAlgorithmOverrides {
  n?: number;
  k?: number;
  t?: number;
  m?: number;
  lambda?: number;
  sample_temperature?: number;
  mutate_temperature?: number;
  judge_temperature?: number;
}

export interface ExternalPromptOverrides {
  generate?: { system?: string; user?: string };
  compare?: { system?: string; user?: string };
  mutate?: { system?: string; user?: string };
  finalize?: { system?: string; user?: string };
}

interface ExternalRoleProviderConfig {
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  model?: string;
  supports_json_mode?: boolean;
}

const nonEmptyString = z.string().trim().min(1);
const promptBlockSchema = z.object({ system: z.string().optional(), user: z.string().optional() }).strict();
const priceSchema = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
    inputUsdPerMillion: z.number().min(0).optional(),
    inputCacheHitUsdPerMillion: z.number().min(0).optional(),
    inputCacheMissUsdPerMillion: z.number().min(0).optional(),
    outputUsdPerMillion: z.number().min(0).optional(),
    longContextThresholdTokens: z.number().int().min(1).optional(),
    inputUsdPerMillionLong: z.number().min(0).optional(),
    outputUsdPerMillionLong: z.number().min(0).optional()
  })
  .strict()
  .superRefine((price, context) => {
    const longFields = [price.longContextThresholdTokens, price.inputUsdPerMillionLong, price.outputUsdPerMillionLong];
    if (longFields.every((entry) => entry === undefined)) return;
    if (
      price.longContextThresholdTokens === undefined ||
      price.inputUsdPerMillion === undefined ||
      price.outputUsdPerMillion === undefined ||
      price.inputUsdPerMillionLong === undefined ||
      price.outputUsdPerMillionLong === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Long-context pricing requires threshold and complete flat/long input/output rates."
      });
    }
  });

const externalConfigSchema = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
    profile: z.enum(["quick", "balanced", "paper"]).optional(),
    provider: nonEmptyString.optional(),
    base_url: z.string().url().optional(),
    api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    supports_json_mode: z.boolean().optional(),
    models: z.object({ generator: nonEmptyString.optional(), mutator: nonEmptyString.optional(), judge: nonEmptyString.optional(), finalizer: nonEmptyString.optional() }).strict().optional(),
    // partialRecord, not record: zod 4 made enum-keyed records EXHAUSTIVE (every
    // role required), while zod 3 treated them as partial. Plain z.record here
    // type-checks but silently rejects every config that omits a role.
    providers: z.partialRecord(
      z.enum(["generator", "mutator", "judge", "finalizer"]),
      z.object({
        provider: nonEmptyString.optional(),
        base_url: z.string().url().optional(),
        api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
        model: nonEmptyString.optional(),
        supports_json_mode: z.boolean().optional()
      }).strict()
    ).optional(),
    concurrency: z.object({ generate: z.number().int().min(1).optional(), judge: z.number().int().min(1).optional(), mutate: z.number().int().min(1).optional() }).strict().optional(),
    retry: z.object({ httpRetries: z.number().int().min(0).optional(), invalidJsonRetries: z.number().int().min(0).optional(), requestTimeoutMs: z.number().int().min(1).optional() }).strict().optional(),
    budget: z.object({
      maxCalls: z.number().int().min(1).optional(),
      maxInputTokens: z.number().int().min(1).optional(),
      maxOutputTokens: z.number().int().min(1).optional(),
      maxUsd: z.number().min(0).optional(),
      prices: z.array(priceSchema).optional()
    }).strict().optional(),
    output: z.object({ includeRawModelOutputs: z.boolean().optional(), includePrompts: z.boolean().optional() }).strict().optional(),
    modelOutputTokens: z.object({
      generation: z.number().int().min(1).optional(),
      mutation: z.number().int().min(1).optional(),
      judge: z.number().int().min(1).optional(),
      finalizer: z.number().int().min(1).optional()
    }).strict().optional(),
    critiqueLimits: z.object({ aggregateChars: z.number().int().min(256).optional() }).strict().optional(),
    rank: z.object({
      mode: z.enum(["all-pairs", "k-regular"]),
      k: z.number().int().min(1).optional(),
      seed: z.number().int().optional(),
      maxCalls: z.number().int().min(1).optional()
    }).strict().optional(),
    providerMaxConcurrency: z.number().int().min(1).max(maxPhaseConcurrency).optional(),
    prompt_style: z.enum(["general", "paper-programming"]).optional(),
    algorithm: z.object({
      n: z.number().int().min(2).optional(),
      k: z.number().int().min(1).optional(),
      t: z.number().int().min(0).optional(),
      m: z.number().int().min(1).optional(),
      lambda: z.number().min(0).optional(),
      sample_temperature: z.number().min(0).optional(),
      mutate_temperature: z.number().min(0).optional(),
      judge_temperature: z.number().min(0).optional()
    }).strict().optional(),
    prompts: z.object({ generate: promptBlockSchema.optional(), compare: promptBlockSchema.optional(), mutate: promptBlockSchema.optional(), finalize: promptBlockSchema.optional() }).strict().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

/** Normalize the public YAML contract to the camelCase core/provider shape. */
export function normalizeExternalConfig(value: unknown, source = "config"): ExternalConfigFile {
  const root = configRecord(value, source);
  assertKnownKeys(
    root,
    [
      "profile", "run_id", "runId", "provider", "base_url", "baseUrl", "api_key_env", "apiKeyEnv",
      "supports_json_mode", "supportsJsonMode", "models", "providers", "concurrency", "retry", "budget",
      "output", "prompt_style", "promptStyle", "algorithm", "prompts", "model_output_tokens", "modelOutputTokens",
      "critique_limits", "critiqueLimits", "rank", "provider_max_concurrency", "providerMaxConcurrency", "metadata"
    ],
    source
  );
  const normalized: ExternalConfigFile = {
    runId: aliased(root, "run_id", "runId", source) as string | undefined,
    profile: root.profile as ExternalConfigFile["profile"],
    provider: root.provider as string | undefined,
    base_url: aliased(root, "base_url", "baseUrl", source) as string | undefined,
    api_key_env: aliased(root, "api_key_env", "apiKeyEnv", source) as string | undefined,
    supports_json_mode: aliased(root, "supports_json_mode", "supportsJsonMode", source) as boolean | undefined,
    models: normalizeModels(root.models, `${source}.models`),
    providers: normalizeProviders(root.providers, `${source}.providers`),
    concurrency: normalizeConcurrency(root.concurrency, `${source}.concurrency`),
    retry: normalizeRetry(root.retry, `${source}.retry`),
    budget: normalizeBudget(root.budget, `${source}.budget`),
    output: normalizeOutput(root.output, `${source}.output`),
    prompt_style: aliased(root, "prompt_style", "promptStyle", source) as ExternalConfigFile["prompt_style"],
    algorithm: normalizeAlgorithm(root.algorithm, `${source}.algorithm`),
    prompts: normalizePrompts(root.prompts, `${source}.prompts`),
    modelOutputTokens: normalizeModelOutputTokens(
      aliased(root, "model_output_tokens", "modelOutputTokens", source),
      `${source}.model_output_tokens`
    ),
    critiqueLimits: normalizeCritiqueLimits(
      aliased(root, "critique_limits", "critiqueLimits", source),
      `${source}.critique_limits`
    ),
    rank: normalizeRank(root.rank, `${source}.rank`),
    providerMaxConcurrency: aliased(root, "provider_max_concurrency", "providerMaxConcurrency", source) as number | undefined,
    metadata: root.metadata === undefined ? undefined : configRecord(root.metadata, `${source}.metadata`)
  };
  const compact = compactConfig(normalized);
  const parsed = externalConfigSchema.safeParse(compact);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config value at ${source}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}.`,
      {
        code: "config.invalid_value",
        retryable: false,
        fix: "Use the documented strings, booleans, enums, and numeric ranges. YAML numeric values must not be quoted."
      }
    );
  }
  return parsed.data as ExternalConfigFile;
}

function normalizeModels(value: unknown, path: string): ExternalConfigFile["models"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["generator", "mutator", "judge", "finalizer"], path);
  return compactConfig({ generator: record.generator as string | undefined, mutator: record.mutator as string | undefined, judge: record.judge as string | undefined, finalizer: record.finalizer as string | undefined });
}

function normalizeProviders(value: unknown, path: string): ExternalConfigFile["providers"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["generator", "mutator", "judge", "finalizer"], path);
  const providers: ExternalConfigFile["providers"] = {};
  for (const role of ["generator", "mutator", "judge", "finalizer"] as const) {
    if (record[role] === undefined) continue;
    const rolePath = `${path}.${role}`;
    const input = configRecord(record[role], rolePath);
    assertKnownKeys(input, ["provider", "base_url", "baseUrl", "api_key_env", "apiKeyEnv", "model", "supports_json_mode", "supportsJsonMode"], rolePath);
    providers[role] = compactConfig({
      provider: input.provider as string | undefined,
      base_url: aliased(input, "base_url", "baseUrl", rolePath) as string | undefined,
      api_key_env: aliased(input, "api_key_env", "apiKeyEnv", rolePath) as string | undefined,
      model: input.model as string | undefined,
      supports_json_mode: aliased(input, "supports_json_mode", "supportsJsonMode", rolePath) as boolean | undefined
    });
  }
  return providers;
}

function normalizeConcurrency(value: unknown, path: string): ExternalConfigFile["concurrency"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["generate", "judge", "mutate"], path);
  return compactConfig({ generate: record.generate as number | undefined, judge: record.judge as number | undefined, mutate: record.mutate as number | undefined });
}

function normalizeRetry(value: unknown, path: string): ExternalConfigFile["retry"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["http_retries", "httpRetries", "invalid_json_retries", "invalidJsonRetries", "request_timeout_ms", "requestTimeoutMs"], path);
  return compactConfig({
    httpRetries: aliased(record, "http_retries", "httpRetries", path) as number | undefined,
    invalidJsonRetries: aliased(record, "invalid_json_retries", "invalidJsonRetries", path) as number | undefined,
    requestTimeoutMs: aliased(record, "request_timeout_ms", "requestTimeoutMs", path) as number | undefined
  });
}

function normalizeBudget(value: unknown, path: string): ExternalConfigFile["budget"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["max_calls", "maxCalls", "max_input_tokens", "maxInputTokens", "max_output_tokens", "maxOutputTokens", "max_usd", "maxUsd", "prices"], path);
  return compactConfig({
    maxCalls: aliased(record, "max_calls", "maxCalls", path) as number | undefined,
    maxInputTokens: aliased(record, "max_input_tokens", "maxInputTokens", path) as number | undefined,
    maxOutputTokens: aliased(record, "max_output_tokens", "maxOutputTokens", path) as number | undefined,
    maxUsd: aliased(record, "max_usd", "maxUsd", path) as number | undefined,
    prices: record.prices === undefined ? undefined : normalizePrices(record.prices, `${path}.prices`)
  }) as ExternalConfigFile["budget"];
}

function normalizePrices(value: unknown, path: string): NonNullable<NonNullable<RunConfig["budget"]>["prices"]> {
  if (!Array.isArray(value)) throw invalidConfigShape(path, "an array");
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = configRecord(entry, entryPath);
    const aliases = [
      ["input_usd_per_million", "inputUsdPerMillion"], ["input_cache_hit_usd_per_million", "inputCacheHitUsdPerMillion"],
      ["input_cache_miss_usd_per_million", "inputCacheMissUsdPerMillion"], ["output_usd_per_million", "outputUsdPerMillion"],
      ["long_context_threshold_tokens", "longContextThresholdTokens"], ["input_usd_per_million_long", "inputUsdPerMillionLong"],
      ["output_usd_per_million_long", "outputUsdPerMillionLong"]
    ] as const;
    assertKnownKeys(record, ["provider", "model", ...aliases.flat()], entryPath);
    return compactConfig({
      provider: record.provider as string, model: record.model as string,
      inputUsdPerMillion: aliased(record, ...aliases[0], entryPath) as number | undefined,
      inputCacheHitUsdPerMillion: aliased(record, ...aliases[1], entryPath) as number | undefined,
      inputCacheMissUsdPerMillion: aliased(record, ...aliases[2], entryPath) as number | undefined,
      outputUsdPerMillion: aliased(record, ...aliases[3], entryPath) as number | undefined,
      longContextThresholdTokens: aliased(record, ...aliases[4], entryPath) as number | undefined,
      inputUsdPerMillionLong: aliased(record, ...aliases[5], entryPath) as number | undefined,
      outputUsdPerMillionLong: aliased(record, ...aliases[6], entryPath) as number | undefined
    });
  });
}

function normalizeOutput(value: unknown, path: string): ExternalConfigFile["output"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["include_raw_model_outputs", "includeRawModelOutputs", "include_prompts", "includePrompts"], path);
  return compactConfig({
    includeRawModelOutputs: aliased(record, "include_raw_model_outputs", "includeRawModelOutputs", path) as boolean | undefined,
    includePrompts: aliased(record, "include_prompts", "includePrompts", path) as boolean | undefined
  });
}

function normalizeAlgorithm(value: unknown, path: string): ExternalConfigFile["algorithm"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["n", "k", "t", "m", "lambda", "sample_temperature", "sampleTemperature", "mutate_temperature", "mutateTemperature", "judge_temperature", "judgeTemperature"], path);
  return compactConfig({
    n: record.n as number | undefined, k: record.k as number | undefined, t: record.t as number | undefined, m: record.m as number | undefined, lambda: record.lambda as number | undefined,
    sample_temperature: aliased(record, "sample_temperature", "sampleTemperature", path) as number | undefined,
    mutate_temperature: aliased(record, "mutate_temperature", "mutateTemperature", path) as number | undefined,
    judge_temperature: aliased(record, "judge_temperature", "judgeTemperature", path) as number | undefined
  });
}

function normalizePrompts(value: unknown, path: string): ExternalConfigFile["prompts"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["generate", "compare", "mutate", "finalize"], path);
  const prompts: ExternalPromptOverrides = {};
  for (const phase of ["generate", "compare", "mutate", "finalize"] as const) {
    if (record[phase] === undefined) continue;
    const phasePath = `${path}.${phase}`;
    const prompt = configRecord(record[phase], phasePath);
    assertKnownKeys(prompt, ["system", "user"], phasePath);
    prompts[phase] = compactConfig({ system: prompt.system as string | undefined, user: prompt.user as string | undefined });
  }
  return prompts;
}

function normalizeModelOutputTokens(value: unknown, path: string): ExternalConfigFile["modelOutputTokens"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["generation", "mutation", "judge", "finalizer"], path);
  return compactConfig({
    generation: record.generation as number | undefined,
    mutation: record.mutation as number | undefined,
    judge: record.judge as number | undefined,
    finalizer: record.finalizer as number | undefined
  });
}

function normalizeCritiqueLimits(value: unknown, path: string): ExternalConfigFile["critiqueLimits"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["aggregate_chars", "aggregateChars"], path);
  return compactConfig({
    aggregateChars: aliased(record, "aggregate_chars", "aggregateChars", path) as number | undefined
  });
}

function normalizeRank(value: unknown, path: string): ExternalConfigFile["rank"] {
  if (value === undefined) return undefined;
  const record = configRecord(value, path);
  assertKnownKeys(record, ["mode", "k", "seed", "max_calls", "maxCalls"], path);
  return compactConfig({
    mode: record.mode as "all-pairs" | "k-regular",
    k: record.k as number | undefined,
    seed: record.seed as number | undefined,
    maxCalls: aliased(record, "max_calls", "maxCalls", path) as number | undefined
  });
}

function configRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidConfigShape(path, "a mapping");
  return value as Record<string, unknown>;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (!unknown.length) return;
  throw new ConfigError(`Unknown config key${unknown.length === 1 ? "" : "s"} at ${path}: ${unknown.join(", ")}.`, {
    code: "config.unknown_key", retryable: false,
    fix: "Remove misspelled or unsupported operational keys. Arbitrary application data is allowed only below metadata."
  });
}

function aliased(record: Record<string, unknown>, canonical: string, camel: string, path: string): unknown {
  const hasCanonical = Object.prototype.hasOwnProperty.call(record, canonical);
  const hasCamel = Object.prototype.hasOwnProperty.call(record, camel);
  if (hasCanonical && hasCamel && JSON.stringify(record[canonical]) !== JSON.stringify(record[camel])) {
    throw new ConfigError(`Conflicting config aliases at ${path}: '${canonical}' and '${camel}' have different values.`, {
      code: "config.alias_conflict", retryable: false,
      fix: `Keep the canonical snake_case '${canonical}' key, or make both aliases identical during migration.`
    });
  }
  return hasCanonical ? record[canonical] : record[camel];
}

function compactConfig<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function invalidConfigShape(path: string, expected: string): ConfigError {
  return new ConfigError(`${path} must be ${expected}.`, { code: "config.invalid_shape", retryable: false, fix: "Use the documented YAML mapping and array structure." });
}
