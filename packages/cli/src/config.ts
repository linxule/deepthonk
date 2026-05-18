import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import YAML from "yaml";
import { builtInProfiles, ConfigError, getProfile, planBudget, type BuiltInProfileName, type Profile, type RunConfig } from "@deepthonk/core";
import {
  defaultConfigPath,
  defaultEnvPath,
  defaultPricesForProviderConfig,
  loadDeepThonkEnv,
  resolveProviderConfig,
  resolveProviderModels,
  type ProviderConfig,
  type ProviderRole
} from "@deepthonk/providers";
import { loadNamedProfile } from "./profileRegistry.js";

export interface ResolvedCliConfig {
  runConfig: RunConfig;
  providerConfig: ProviderConfig;
  plan: ReturnType<typeof planBudget>;
}

export interface ResolvedProviderConfig {
  providerConfig: ProviderConfig;
  models: ProviderConfig["models"];
}

export { defaultConfigPath, defaultEnvPath, loadDeepThonkEnv };

export interface RawConfigFile {
  profile?: BuiltInProfileName;
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  models?: {
    generator?: string;
    mutator?: string;
    judge?: string;
    finalizer?: string;
  };
  providers?: Partial<Record<ProviderRole, RawRoleProviderConfig>>;
  concurrency?: Partial<RunConfig["concurrency"]>;
  retry?: Partial<RunConfig["retry"]>;
  budget?: RunConfig["budget"];
  output?: Partial<RunConfig["output"]>;
  prompt_style?: RunConfig["promptStyle"];
  algorithm?: AlgorithmOverrides;
  prompts?: PromptOverridesFile;
}

export interface AlgorithmOverrides {
  n?: number;
  k?: number;
  t?: number;
  m?: number;
  lambda?: number;
  sample_temperature?: number;
  mutate_temperature?: number;
  judge_temperature?: number;
}

interface PromptOverridesFile {
  generate?: { system?: string; user?: string };
  compare?: { system?: string; user?: string };
  mutate?: { system?: string; user?: string };
  finalize?: { system?: string; user?: string };
}

interface RawRoleProviderConfig {
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  model?: string;
  supports_json_mode?: boolean;
}

export async function resolveRunConfig(options: Record<string, unknown>): Promise<ResolvedCliConfig> {
  await loadDeepThonkEnv();
  const fileConfig = await resolveBaseConfig(options);
  const profileName = builtInProfileName(options.profile ?? fileConfig.profile ?? "quick");
  const profile = mergeAlgorithmOverrides(getProfile(profileName), fileConfig.algorithm, options);
  const task = await readPathOrInline(String(options.task ?? ""));
  const rubric = options.rubric ? await readPathOrInline(String(options.rubric)) : undefined;
  const provider = String(options.provider ?? fileConfig.provider ?? "fake");
  const models = resolveProviderModels(provider, {
    generator: stringOption(options.generatorModel) ?? fileConfig.models?.generator,
    mutator: stringOption(options.mutatorModel) ?? fileConfig.models?.mutator,
    judge: stringOption(options.judgeModel) ?? fileConfig.models?.judge,
    finalizer: stringOption(options.finalizerModel) ?? fileConfig.models?.finalizer
  });
  const maxConcurrency = numberOption(options.maxConcurrency);
  const retry = {
    httpRetries: fileConfig.retry?.httpRetries ?? 2,
    invalidJsonRetries: fileConfig.retry?.invalidJsonRetries ?? 1,
    requestTimeoutMs: numberOption(options.requestTimeoutMs) ?? fileConfig.retry?.requestTimeoutMs
  };
  const providerConfig: ProviderConfig = resolveProviderConfig({
    provider,
    baseUrl: stringOption(options.baseUrl) ?? fileConfig.base_url,
    apiKeyEnv: stringOption(options.apiKeyEnv) ?? fileConfig.api_key_env,
    models,
    roleProviders: normalizeRoleProviders(fileConfig.providers, models),
    retry
  });
  const budget = mergeBudget(fileConfig.budget, {
    maxCalls: numberOption(options.maxCalls),
    maxInputTokens: numberOption(options.maxInputTokens),
    maxOutputTokens: numberOption(options.maxOutputTokens),
    maxUsd: numberOption(options.maxUsd)
  }, defaultPricesForProviderConfig(providerConfig));
  const promptOverrides = await loadPromptOverrides(options, fileConfig);
  const runConfig: RunConfig = {
    task,
    rubric,
    promptStyle:
      (stringOption(options.promptStyle) as RunConfig["promptStyle"] | undefined) ??
      fileConfig.prompt_style ??
      (profileName === "paper" ? "paper-programming" : "general"),
    promptOverrides,
    profile,
    runDir: resolveCliPath(String(options.out ?? `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`)),
    seed: numberOption(options.seed) ?? 1,
    provider,
    generatorModel: models.generator,
    mutatorModel: models.mutator,
    judgeModel: models.judge,
    finalizerModel: models.finalizer,
    concurrency: {
      generate: maxConcurrency ?? fileConfig.concurrency?.generate ?? profile.n,
      judge: maxConcurrency ?? fileConfig.concurrency?.judge ?? Math.max(1, (profile.n * Math.max(profile.k, profile.m)) / 2),
      mutate: maxConcurrency ?? fileConfig.concurrency?.mutate ?? profile.n - Math.floor(profile.n / 4)
    },
    retry,
    budget,
    output: {
      includeRawModelOutputs: booleanOption(options.includeRawModelOutputs) ?? fileConfig.output?.includeRawModelOutputs ?? false,
      includePrompts: booleanOption(options.includePrompts) ?? fileConfig.output?.includePrompts ?? false
    }
  };
  return {
    runConfig,
    providerConfig,
    plan: planBudget(profile)
  };
}

export async function resolveProviderOnlyConfig(options: Record<string, unknown>): Promise<ResolvedProviderConfig> {
  await loadDeepThonkEnv();
  const fileConfig = await resolveBaseConfig(options);
  const provider = String(options.provider ?? fileConfig.provider ?? "fake");
  const models = resolveProviderModels(provider, {
    generator: stringOption(options.generatorModel) ?? fileConfig.models?.generator,
    mutator: stringOption(options.mutatorModel) ?? fileConfig.models?.mutator,
    judge: stringOption(options.judgeModel) ?? fileConfig.models?.judge,
    finalizer: stringOption(options.finalizerModel) ?? fileConfig.models?.finalizer
  });
  return {
    models,
    providerConfig: resolveProviderConfig({
      provider,
      baseUrl: stringOption(options.baseUrl) ?? fileConfig.base_url,
      apiKeyEnv: stringOption(options.apiKeyEnv) ?? fileConfig.api_key_env,
      models,
      roleProviders: normalizeRoleProviders(fileConfig.providers, models),
      retry: {
        httpRetries: fileConfig.retry?.httpRetries ?? 2,
        requestTimeoutMs: numberOption(options.requestTimeoutMs) ?? fileConfig.retry?.requestTimeoutMs
      }
    })
  };
}

export function profileFromOptions(options: Record<string, unknown>): Profile {
  const base = getProfile(builtInProfileName(options.profile ?? "quick"));
  return mergeAlgorithmOverrides(base, undefined, options);
}

export async function loadPromptOverrides(
  options: Record<string, unknown>,
  fileConfig: RawConfigFile
): Promise<RunConfig["promptOverrides"]> {
  let fromFlag: PromptOverridesFile | undefined;
  const path = stringOption(options.prompts);
  if (path) {
    const resolved = resolveCliPath(path);
    if (!existsSync(resolved)) {
      throw new ConfigError(`--prompts file does not exist: ${path}`, {
        code: "config.prompts_file_missing",
        retryable: false,
        fix: "Pass a YAML file path. The file should map phase names to { system, user } templates."
      });
    }
    fromFlag = YAML.parse(await readFile(resolved, "utf8")) as PromptOverridesFile;
  }
  const fromJson = parsePromptOverridesJson(stringOption(options.promptsJson));
  const merged: PromptOverridesFile = { ...(fileConfig.prompts ?? {}) };
  if (fromFlag) {
    for (const phase of ["generate", "compare", "mutate", "finalize"] as const) {
      if (fromFlag[phase]) merged[phase] = { ...(merged[phase] ?? {}), ...fromFlag[phase] };
    }
  }
  if (fromJson) {
    for (const phase of ["generate", "compare", "mutate", "finalize"] as const) {
      if (fromJson[phase]) merged[phase] = { ...(merged[phase] ?? {}), ...fromJson[phase] };
    }
  }
  return Object.keys(merged).length ? (merged as RunConfig["promptOverrides"]) : undefined;
}

export function mergeAlgorithmOverrides(
  base: Profile,
  fileOverrides: AlgorithmOverrides | undefined,
  cliOptions: Record<string, unknown>
): Profile {
  return {
    n: numberOption(cliOptions.n) ?? fileOverrides?.n ?? base.n,
    k: numberOption(cliOptions.k) ?? fileOverrides?.k ?? base.k,
    t: numberOption(cliOptions.t) ?? fileOverrides?.t ?? base.t,
    m: numberOption(cliOptions.m) ?? fileOverrides?.m ?? base.m,
    lambda: numberOption(cliOptions.lambda) ?? fileOverrides?.lambda ?? base.lambda,
    sampleTemperature:
      numberOption(cliOptions.sampleTemperature) ?? fileOverrides?.sample_temperature ?? base.sampleTemperature,
    mutateTemperature:
      numberOption(cliOptions.mutateTemperature) ?? fileOverrides?.mutate_temperature ?? base.mutateTemperature,
    judgeTemperature:
      numberOption(cliOptions.judgeTemperature) ?? fileOverrides?.judge_temperature ?? base.judgeTemperature
  };
}

export async function resolvePlanProfile(options: Record<string, unknown>): Promise<Profile | BuiltInProfileName> {
  const fileConfig = await resolveBaseConfig(options);
  const profileName = builtInProfileName(options.profile ?? fileConfig.profile ?? "quick");
  const hasOverrides =
    fileConfig.algorithm !== undefined ||
    ["n", "k", "t", "m", "lambda", "sampleTemperature", "mutateTemperature", "judgeTemperature"].some((key) => options[key] !== undefined);
  if (!hasOverrides) return profileName;
  return mergeAlgorithmOverrides(getProfile(profileName), fileConfig.algorithm, options);
}

export async function readPathOrInline(value: string): Promise<string> {
  if (!value) return "";
  const candidates = candidatePaths(value);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) return readFile(path, "utf8");
  if (looksPathLike(value)) throw new ConfigError(`Input path does not exist: ${value}. Use inline text without path separators, or fix the path.`);
  return value;
}

export function resolveCliPath(value: string): string {
  return candidatePaths(value)[0];
}

function candidatePaths(value: string): string[] {
  if (value.startsWith("/")) return [value];
  return [
    process.env.INIT_CWD ? resolve(process.env.INIT_CWD, value) : undefined,
    resolve(value),
    resolve(process.cwd(), "../..", value)
  ].filter((path): path is string => Boolean(path));
}

async function readConfig(path: string): Promise<RawConfigFile> {
  return YAML.parse(await readFile(resolveCliPath(path), "utf8")) as RawConfigFile;
}

function resolveConfigPath(options: Record<string, unknown>): string | undefined {
  return stringOption(options.config) ?? process.env.DEEPTHONK_CONFIG ?? (existsSync(defaultConfigPath) ? defaultConfigPath : undefined);
}

async function resolveBaseConfig(options: Record<string, unknown>): Promise<RawConfigFile> {
  const profileName = stringOption(options.profileName);
  if (profileName) {
    if (stringOption(options.config)) {
      throw new ConfigError("--profile-name and --config cannot be used together. A named profile replaces the config file.", {
        code: "config.profile_and_config_conflict",
        retryable: false,
        fix: "Choose one: --profile-name <name> to load a saved bundle, or --config <path> to point at a config YAML."
      });
    }
    return (await loadNamedProfile(profileName)) as unknown as RawConfigFile;
  }
  const configPath = resolveConfigPath(options);
  return configPath ? await readConfig(configPath) : {};
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return Number(value);
}

function booleanOption(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return Boolean(value);
}

function mergeBudget(
  fileBudget: RunConfig["budget"],
  overrides: Partial<NonNullable<RunConfig["budget"]>>,
  defaultPrices: NonNullable<NonNullable<RunConfig["budget"]>["prices"]> = []
): RunConfig["budget"] {
  const prices = mergePrices(defaultPrices, fileBudget?.prices);
  const definedOverrides = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  if (!fileBudget && !Object.keys(definedOverrides).length && prices.length === 0) return undefined;
  const merged = {
    ...(fileBudget ?? {}),
    ...definedOverrides,
    prices
  } as RunConfig["budget"];
  return merged && Object.keys(merged).length ? merged : undefined;
}

function mergePrices(
  defaults: NonNullable<NonNullable<RunConfig["budget"]>["prices"]>,
  overrides: NonNullable<NonNullable<RunConfig["budget"]>["prices"]> | undefined
): NonNullable<NonNullable<RunConfig["budget"]>["prices"]> {
  const byKey = new Map(defaults.map((price) => [`${price.provider}/${price.model}`, price]));
  for (const price of overrides ?? []) byKey.set(`${price.provider}/${price.model}`, price);
  return [...byKey.values()];
}

function stringOption(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function parsePromptOverridesJson(value: string | undefined): PromptOverridesFile | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as PromptOverridesFile;
  } catch (error) {
    throw new ConfigError(`--prompts-json is not valid JSON: ${(error as Error).message}`, {
      code: "config.prompts_json_invalid",
      retryable: false,
      fix: "Pass a JSON object with generate/compare/mutate/finalize phase keys."
    });
  }
}

function builtInProfileName(value: unknown): BuiltInProfileName {
  const profile = String(value);
  if (profile === "quick" || profile === "balanced" || profile === "paper") return profile;
  throw new ConfigError(`Unknown profile: ${profile}. Use quick, balanced, or paper.`);
}

function looksPathLike(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  const extension = extname(basename(value)).toLowerCase();
  return [".txt", ".md", ".json", ".jsonl", ".yaml", ".yml"].includes(extension);
}

function normalizeRoleProviders(
  providers: RawConfigFile["providers"],
  models: ProviderConfig["models"]
): Parameters<typeof resolveProviderConfig>[0]["roleProviders"] {
  if (!providers) return undefined;
  const normalized: Parameters<typeof resolveProviderConfig>[0]["roleProviders"] = {};
  for (const role of ["generator", "mutator", "judge", "finalizer"] as const) {
    const provider = providers[role];
    if (!provider) continue;
    const model = provider.model ?? models[role];
    if (!model) continue;
    normalized[role] = {
      provider: provider.provider,
      baseUrl: provider.base_url,
      apiKeyEnv: provider.api_key_env,
      model,
      supportsJsonMode: provider.supports_json_mode
    };
  }
  return Object.keys(normalized).length ? normalized : undefined;
}
