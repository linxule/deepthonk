import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { builtInProfiles, ConfigError, getProfile, planBudget, type BuiltInProfileName, type Profile, type RunConfig } from "@deepthonk/core";
import { defaultPricesForProviderConfig, resolveProviderConfig, resolveProviderModels, type ProviderConfig, type ProviderRole } from "@deepthonk/providers";

export interface ResolvedCliConfig {
  runConfig: RunConfig;
  providerConfig: ProviderConfig;
  plan: ReturnType<typeof planBudget>;
}

export interface ResolvedProviderConfig {
  providerConfig: ProviderConfig;
  models: ProviderConfig["models"];
}

export const defaultConfigPath = join(homedir(), ".config", "deepthonk", "config.yaml");
export const defaultEnvPath = join(dirname(defaultConfigPath), "env");

interface RawConfigFile {
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
  const configPath = resolveConfigPath(options);
  const fileConfig = configPath ? await readConfig(configPath) : {};
  const profileName = builtInProfileName(options.profile ?? fileConfig.profile ?? "quick");
  const profile = getProfile(profileName);
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
  const runConfig: RunConfig = {
    task,
    rubric,
    promptStyle: fileConfig.prompt_style ?? (profileName === "paper" ? "paper-programming" : "general"),
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
      includeRawModelOutputs: fileConfig.output?.includeRawModelOutputs ?? false,
      includePrompts: fileConfig.output?.includePrompts ?? false
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
  const configPath = resolveConfigPath(options);
  const fileConfig = configPath ? await readConfig(configPath) : {};
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
  if (options.n || options.k || options.t || options.m) {
    const base = builtInProfiles[builtInProfileName(options.profile ?? "quick")];
    return {
      ...base,
      n: numberOption(options.n) ?? base.n,
      k: numberOption(options.k) ?? base.k,
      t: numberOption(options.t) ?? base.t,
      m: numberOption(options.m) ?? base.m
    };
  }
  return getProfile(builtInProfileName(options.profile ?? "quick"));
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

export async function loadDeepThonkEnv(path = process.env.DEEPTHONK_ENV ?? defaultEnvPath): Promise<void> {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return undefined;
  return [match[1], unquoteEnvValue(match[2].trim())];
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    const inner = value.slice(1, -1);
    return value.startsWith("'") ? inner.replace(/'\\''/g, "'") : inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return Number(value);
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
