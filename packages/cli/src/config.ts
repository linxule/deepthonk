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
  normalizeExternalConfig,
  resolveProviderConfig,
  resolveProviderModels,
  type ExternalAlgorithmOverrides,
  type ExternalConfigFile,
  type ExternalPromptOverrides,
  type ProviderConfig,
} from "@deepthonk/providers";
import { booleanOption, numberOption, stringOption } from "./options.js";
import { loadNamedProfile } from "./profileRegistry.js";
import { providerReplayFromConfig, type ProviderReplay } from "./providerReplay.js";

export interface ResolvedCliConfig {
  runConfig: RunConfig;
  providerConfig: ProviderConfig;
  providerReplay: ProviderReplay;
  plan: ReturnType<typeof planBudget>;
}

export interface ResolvedProviderConfig {
  providerConfig: ProviderConfig;
  models: ProviderConfig["models"];
}

export interface ResolvedOneShotConfig extends ResolvedProviderConfig {
  profile: Profile;
  retry: RunConfig["retry"];
  promptStyle: RunConfig["promptStyle"];
  promptOverrides?: RunConfig["promptOverrides"];
  concurrency: RunConfig["concurrency"];
  modelOutputTokens?: RunConfig["modelOutputTokens"];
  rank?: RunConfig["rank"];
  providerMaxConcurrency?: number;
}

export interface ResolvedPlanConfig {
  profile: Profile | BuiltInProfileName;
  planOptions: {
    invalidJsonRetries: number;
    includeFinalizer: boolean;
  };
}

interface ProviderSelection {
  provider: string;
  models: ProviderConfig["models"];
  baseUrl?: string;
  apiKeyEnv?: string;
  supportsJsonMode?: boolean;
  roleProviders?: Parameters<typeof resolveProviderConfig>[0]["roleProviders"];
  inheritProviderDefaults: boolean;
  providerMaxConcurrency?: number;
}

export { defaultConfigPath, defaultEnvPath, loadDeepThonkEnv };

export type RawConfigFile = ExternalConfigFile;
export type AlgorithmOverrides = ExternalAlgorithmOverrides;
type PromptOverridesFile = ExternalPromptOverrides;

export async function resolveRunConfig(options: Record<string, unknown>): Promise<ResolvedCliConfig> {
  await loadDeepThonkEnv();
  const fileConfig = await resolveBaseConfig(options);
  const profileName = builtInProfileName(options.profile ?? fileConfig.profile ?? "quick");
  const profile = mergeAlgorithmOverrides(getProfile(profileName), fileConfig.algorithm, options);
  const task = await readPathOrInline(String(options.task ?? ""));
  const rubric = options.rubric ? await readPathOrInline(String(options.rubric)) : undefined;
  const selection = resolveProviderSelection(options, fileConfig);
  const { provider, models } = selection;
  const maxConcurrency = numberOption(options.maxConcurrency, "--max-concurrency", { integer: true, min: 1 });
  const retry = resolveRetry(options, fileConfig);
  const providerConfig: ProviderConfig = resolveProviderConfig({
    provider,
    baseUrl: selection.baseUrl,
    apiKeyEnv: selection.apiKeyEnv,
    supportsJsonMode: selection.supportsJsonMode,
    models,
    roleProviders: selection.roleProviders,
    inheritProviderDefaults: selection.inheritProviderDefaults,
    providerMaxConcurrency: selection.providerMaxConcurrency,
    retry
  });
  const budget = mergeBudget(fileConfig.budget, {
    maxCalls: numberOption(options.maxCalls, "--max-calls", { integer: true, min: 1 }),
    maxInputTokens: numberOption(options.maxInputTokens, "--max-input-tokens", { integer: true, min: 1 }),
    maxOutputTokens: numberOption(options.maxOutputTokens, "--max-output-tokens", { integer: true, min: 1 }),
    maxUsd: numberOption(options.maxUsd, "--max-usd", { min: 0 })
  }, defaultPricesForProviderConfig(providerConfig));
  const promptOverrides = await loadPromptOverrides(options, fileConfig);
  const providerReplay = providerReplayFromConfig(providerConfig);
  const runConfig: RunConfig = {
    runId: stringOption(options.runId) ?? fileConfig.runId,
    task,
    rubric,
    promptStyle:
      (stringOption(options.promptStyle) as RunConfig["promptStyle"] | undefined) ??
      fileConfig.prompt_style ??
      defaultPromptStyle(profileName),
    promptOverrides,
    profile,
    runDir: resolveCliPath(String(options.out ?? `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`)),
    seed: numberOption(options.seed, "--seed", { integer: true }) ?? 1,
    provider,
    providerReplay,
    generatorModel: models.generator,
    mutatorModel: models.mutator,
    judgeModel: models.judge,
    finalizerModel: models.finalizer,
    modelOutputTokens: resolveModelOutputTokens(options, fileConfig),
    critiqueLimits: resolveCritiqueLimits(options, fileConfig),
    rank: resolveRankConfig(options, fileConfig),
    providerMaxConcurrency: selection.providerMaxConcurrency,
    concurrency: resolveRunConcurrency(profile, fileConfig, options, maxConcurrency),
    retry,
    budget,
    output: {
      includeRawModelOutputs: booleanOption(options.includeRawModelOutputs, "--include-raw-model-outputs") ?? fileConfig.output?.includeRawModelOutputs ?? false,
      includePrompts: booleanOption(options.includePrompts, "--include-prompts") ?? fileConfig.output?.includePrompts ?? false
    }
  };
  return {
    runConfig,
    providerConfig,
    providerReplay,
    plan: planBudget(profile, {
      invalidJsonRetries: retry.invalidJsonRetries,
      includeFinalizer: Boolean(models.finalizer)
    })
  };
}

export async function resolveOneShotConfig(options: Record<string, unknown>): Promise<ResolvedOneShotConfig> {
  await loadDeepThonkEnv();
  const fileConfig = await resolveBaseConfig(options);
  const profileName = builtInProfileName(options.profile ?? fileConfig.profile ?? "quick");
  const profile = mergeAlgorithmOverrides(getProfile(profileName), fileConfig.algorithm, options);
  const selection = resolveProviderSelection(options, fileConfig);
  const { provider, models } = selection;
  const retry = resolveRetry(options, fileConfig);
  const providerConfig = resolveProviderConfig({
    provider,
    baseUrl: selection.baseUrl,
    apiKeyEnv: selection.apiKeyEnv,
    supportsJsonMode: selection.supportsJsonMode,
    models,
    roleProviders: selection.roleProviders,
    inheritProviderDefaults: selection.inheritProviderDefaults,
    providerMaxConcurrency: selection.providerMaxConcurrency,
    retry
  });
  return {
    models,
    providerConfig,
    profile,
    retry,
    promptStyle:
      (stringOption(options.promptStyle) as RunConfig["promptStyle"] | undefined) ??
      fileConfig.prompt_style ??
      defaultPromptStyle(profileName),
    promptOverrides: await loadPromptOverrides(options, fileConfig),
    concurrency: resolveRunConcurrency(profile, fileConfig, options),
    modelOutputTokens: resolveModelOutputTokens(options, fileConfig),
    rank: resolveRankConfig(options, fileConfig),
    providerMaxConcurrency: selection.providerMaxConcurrency
  };
}

export async function resolveProviderOnlyConfig(options: Record<string, unknown>): Promise<ResolvedProviderConfig> {
  const resolved = await resolveOneShotConfig(options);
  return {
    models: resolved.models,
    providerConfig: resolved.providerConfig
  };
}

function resolveRetry(options: Record<string, unknown>, fileConfig: RawConfigFile): RunConfig["retry"] {
  return {
    httpRetries: fileConfig.retry?.httpRetries ?? 2,
    invalidJsonRetries: fileConfig.retry?.invalidJsonRetries ?? 1,
    requestTimeoutMs: numberOption(options.requestTimeoutMs, "--request-timeout-ms", { integer: true, min: 1 }) ?? fileConfig.retry?.requestTimeoutMs
  };
}

function resolveProviderSelection(options: Record<string, unknown>, fileConfig: RawConfigFile): ProviderSelection {
  const providerFlag = stringOption(options.provider);
  const baseUrlFlag = stringOption(options.baseUrl);
  const provider = String(providerFlag ?? fileConfig.provider ?? "fake");
  const providerChanged = providerFlag !== undefined && providerFlag !== fileConfig.provider;
  const baseUrlChanged = baseUrlFlag !== undefined && baseUrlFlag !== fileConfig.base_url;
  const isolateFileRoute = providerChanged || baseUrlChanged;
  const models = resolveProviderModels(provider, {
    generator: stringOption(options.generatorModel) ?? (isolateFileRoute ? undefined : fileConfig.models?.generator),
    mutator: stringOption(options.mutatorModel) ?? (isolateFileRoute ? undefined : fileConfig.models?.mutator),
    judge: stringOption(options.judgeModel) ?? (isolateFileRoute ? undefined : fileConfig.models?.judge),
    finalizer: stringOption(options.finalizerModel) ?? (isolateFileRoute ? undefined : fileConfig.models?.finalizer)
  });
  const supportsJsonMode =
    booleanOption(options.supportsJsonMode, "--supports-json-mode") ??
    (isolateFileRoute ? undefined : fileConfig.supports_json_mode);
  return {
    provider,
    models,
    baseUrl: baseUrlFlag ?? (isolateFileRoute ? undefined : fileConfig.base_url),
    apiKeyEnv: stringOption(options.apiKeyEnv) ?? (isolateFileRoute ? undefined : fileConfig.api_key_env),
    supportsJsonMode,
    roleProviders: isolateFileRoute ? undefined : normalizeRoleProviders(fileConfig.providers),
    inheritProviderDefaults: !baseUrlChanged,
    providerMaxConcurrency:
      numberOption(options.providerMaxConcurrency, "--provider-max-concurrency", { integer: true, min: 1, max: 1_024 }) ??
      fileConfig.providerMaxConcurrency
  };
}

function resolveModelOutputTokens(
  options: Record<string, unknown>,
  fileConfig: RawConfigFile
): RunConfig["modelOutputTokens"] {
  const resolved = {
    generation:
      numberOption(options.generationOutputTokens, "--generation-output-tokens", { integer: true, min: 1 }) ??
      fileConfig.modelOutputTokens?.generation,
    mutation:
      numberOption(options.mutationOutputTokens, "--mutation-output-tokens", { integer: true, min: 1 }) ??
      fileConfig.modelOutputTokens?.mutation,
    judge:
      numberOption(options.judgeOutputTokens, "--judge-output-tokens", { integer: true, min: 1 }) ??
      fileConfig.modelOutputTokens?.judge,
    finalizer:
      numberOption(options.finalizerOutputTokens, "--finalizer-output-tokens", { integer: true, min: 1 }) ??
      fileConfig.modelOutputTokens?.finalizer
  };
  const compact = compactDefined(resolved);
  return Object.keys(compact).length ? compact : undefined;
}

function resolveCritiqueLimits(options: Record<string, unknown>, fileConfig: RawConfigFile): RunConfig["critiqueLimits"] {
  const aggregateChars =
    numberOption(options.maxCritiqueChars, "--max-critique-chars", { integer: true, min: 256 }) ??
    fileConfig.critiqueLimits?.aggregateChars;
  return aggregateChars === undefined ? undefined : { aggregateChars };
}

function resolveRankConfig(options: Record<string, unknown>, fileConfig: RawConfigFile): RunConfig["rank"] {
  const mode = stringOption(options.rankMode) ?? fileConfig.rank?.mode;
  const k = numberOption(options.rankK, "--rank-k", { integer: true, min: 1 }) ?? fileConfig.rank?.k;
  const seed = numberOption(options.rankSeed, "--rank-seed", { integer: true }) ?? fileConfig.rank?.seed;
  const maxCalls = numberOption(options.rankMaxCalls, "--rank-max-calls", { integer: true, min: 1 }) ?? fileConfig.rank?.maxCalls;
  if (mode === undefined) {
    if (k !== undefined || seed !== undefined || maxCalls !== undefined) {
      throw new ConfigError("Rank tuning requires rank.mode or --rank-mode.", {
        code: "config.rank_mode_required",
        retryable: false,
        fix: "Set rank.mode to all-pairs or k-regular."
      });
    }
    return undefined;
  }
  if (mode !== "all-pairs" && mode !== "k-regular") {
    throw new ConfigError(`--rank-mode must be all-pairs or k-regular. Received '${mode}'.`, {
      code: "config.invalid_cli_option",
      retryable: false,
      fix: "Pass --rank-mode all-pairs or --rank-mode k-regular."
    });
  }
  return { mode, k, seed, maxCalls };
}

function compactDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
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
    n: numberOption(cliOptions.n, "--n", { integer: true, min: 2 }) ?? fileOverrides?.n ?? base.n,
    k: numberOption(cliOptions.k, "--k", { integer: true, min: 1 }) ?? fileOverrides?.k ?? base.k,
    t: numberOption(cliOptions.t, "--t", { integer: true, min: 0 }) ?? fileOverrides?.t ?? base.t,
    m: numberOption(cliOptions.m, "--m", { integer: true, min: 1 }) ?? fileOverrides?.m ?? base.m,
    lambda: numberOption(cliOptions.lambda, "--lambda", { min: 0 }) ?? fileOverrides?.lambda ?? base.lambda,
    sampleTemperature:
      numberOption(cliOptions.sampleTemperature, "--sample-temperature", { min: 0 }) ?? fileOverrides?.sample_temperature ?? base.sampleTemperature,
    mutateTemperature:
      numberOption(cliOptions.mutateTemperature, "--mutate-temperature", { min: 0 }) ?? fileOverrides?.mutate_temperature ?? base.mutateTemperature,
    judgeTemperature:
      numberOption(cliOptions.judgeTemperature, "--judge-temperature", { min: 0 }) ?? fileOverrides?.judge_temperature ?? base.judgeTemperature
  };
}

export async function resolvePlanProfile(options: Record<string, unknown>): Promise<Profile | BuiltInProfileName> {
  return (await resolvePlanConfig(options)).profile;
}

export async function resolvePlanConfig(options: Record<string, unknown>): Promise<ResolvedPlanConfig> {
  const fileConfig = await resolveBaseConfig(options);
  const profileName = builtInProfileName(options.profile ?? fileConfig.profile ?? "quick");
  const hasOverrides =
    fileConfig.algorithm !== undefined ||
    ["n", "k", "t", "m", "lambda", "sampleTemperature", "mutateTemperature", "judgeTemperature"].some((key) => options[key] !== undefined);
  return {
    profile: hasOverrides ? mergeAlgorithmOverrides(getProfile(profileName), fileConfig.algorithm, options) : profileName,
    planOptions: {
      invalidJsonRetries: fileConfig.retry?.invalidJsonRetries ?? 1,
      includeFinalizer: Boolean(fileConfig.models?.finalizer)
    }
  };
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
  const resolved = resolveCliPath(path);
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new ConfigError(`Config '${path}' is not valid YAML: ${(error as Error).message}`, {
      code: "config.invalid_yaml",
      retryable: false,
      fix: `Fix YAML syntax in ${resolved}.`
    });
  }
  return normalizeExternalConfig(parsed, path);
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
    return normalizeExternalConfig(await loadNamedProfile(profileName), `named profile '${profileName}'`);
  }
  const configPath = resolveConfigPath(options);
  return configPath ? await readConfig(configPath) : {};
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

function defaultPromptStyle(profileName: BuiltInProfileName): RunConfig["promptStyle"] {
  return profileName === "paper" ? "paper-programming" : "general";
}

function resolveRunConcurrency(
  profile: Profile,
  fileConfig: RawConfigFile,
  options: Record<string, unknown>,
  maxConcurrency = numberOption(options.maxConcurrency, "--max-concurrency", { integer: true, min: 1 })
): RunConfig["concurrency"] {
  return {
    generate:
      numberOption(options.generateConcurrency, "--generate-concurrency", { integer: true, min: 1 }) ??
      maxConcurrency ??
      fileConfig.concurrency?.generate ??
      profile.n,
    judge:
      numberOption(options.judgeConcurrency, "--judge-concurrency", { integer: true, min: 1 }) ??
      maxConcurrency ??
      fileConfig.concurrency?.judge ??
      Math.max(1, (profile.n * Math.max(profile.k, profile.m)) / 2),
    mutate:
      numberOption(options.mutateConcurrency, "--mutate-concurrency", { integer: true, min: 1 }) ??
      maxConcurrency ??
      fileConfig.concurrency?.mutate ??
      profile.n - Math.floor(profile.n / 4)
  };
}

function looksPathLike(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  const extension = extname(basename(value)).toLowerCase();
  return [".txt", ".md", ".json", ".jsonl", ".yaml", ".yml"].includes(extension);
}

function normalizeRoleProviders(
  providers: RawConfigFile["providers"]
): Parameters<typeof resolveProviderConfig>[0]["roleProviders"] {
  if (!providers) return undefined;
  const normalized: Parameters<typeof resolveProviderConfig>[0]["roleProviders"] = {};
  for (const role of ["generator", "mutator", "judge", "finalizer"] as const) {
    const provider = providers[role];
    if (!provider) continue;
    normalized[role] = {
      provider: provider.provider,
      baseUrl: provider.base_url,
      apiKeyEnv: provider.api_key_env,
      model: provider.model,
      supportsJsonMode: provider.supports_json_mode
    };
  }
  return Object.keys(normalized).length ? normalized : undefined;
}
