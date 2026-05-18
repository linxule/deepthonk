import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { ConfigError } from "@deepthonk/core";
import { resolveCliPath } from "../../config.js";
import { loadNamedProfile, NAMED_PROFILE_NAME_RE, profilePath, profilesDir, type NamedProfileBundle } from "../../profileRegistry.js";

const RAW_API_KEY_RE = /^api[_-]?key$/i;

export interface ProfileSaveOptions {
  force?: boolean;
}

export interface ProfileSaveFlagOptions {
  provider?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  generatorModel?: string;
  mutatorModel?: string;
  judgeModel?: string;
  finalizerModel?: string;
  profile?: string;
  promptStyle?: string;
  n?: string;
  k?: string;
  t?: string;
  m?: string;
  lambda?: string;
  sampleTemperature?: string;
  mutateTemperature?: string;
  judgeTemperature?: string;
}

export const PROFILE_SAVE_FLAG_KEYS = [
  "provider",
  "apiKeyEnv",
  "generatorModel",
  "mutatorModel",
  "judgeModel",
  "finalizerModel",
  "profile",
  "promptStyle",
  "n",
  "k",
  "t",
  "m",
  "lambda",
  "sampleTemperature",
  "mutateTemperature",
  "judgeTemperature"
] as const;

export async function readProfileBundleFromConfig(path: string): Promise<NamedProfileBundle> {
  const resolved = resolveCliPath(path);
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new ConfigError(`Profile config is not valid YAML: ${(error as Error).message}`, {
      code: "config.profile_invalid_yaml",
      retryable: false,
      fix: `Fix YAML syntax in ${resolved}.`
    });
  }
  return parsed as NamedProfileBundle;
}

export function profileBundleFromFlags(options: ProfileSaveFlagOptions): NamedProfileBundle {
  rejectRawApiKeyFlag(options);
  const bundle: NamedProfileBundle = {};
  const profile = stringOption(options.profile);
  if (profile) bundle.profile = builtInProfile(profile);
  const promptStyle = stringOption(options.promptStyle);
  if (promptStyle) bundle.prompt_style = promptStyleName(promptStyle);
  const provider = stringOption(options.provider);
  if (provider) bundle.provider = provider;
  const apiKeyEnv = stringOption(options.apiKeyEnv);
  if (apiKeyEnv) bundle.api_key_env = apiKeyEnv;

  const models = {
    generator: stringOption(options.generatorModel),
    mutator: stringOption(options.mutatorModel),
    judge: stringOption(options.judgeModel),
    finalizer: stringOption(options.finalizerModel)
  };
  if (Object.values(models).some((value) => value !== undefined)) {
    bundle.models = Object.fromEntries(Object.entries(models).filter(([, value]) => value !== undefined)) as NamedProfileBundle["models"];
  }

  const algorithm = {
    n: numberOption(options.n, "--n", { integer: true, min: 2 }),
    k: numberOption(options.k, "--k", { integer: true, min: 1 }),
    t: numberOption(options.t, "--t", { integer: true, min: 0 }),
    m: numberOption(options.m, "--m", { integer: true, min: 1 }),
    lambda: numberOption(options.lambda, "--lambda", { min: 0 }),
    sample_temperature: numberOption(options.sampleTemperature, "--sample-temperature", { min: 0 }),
    mutate_temperature: numberOption(options.mutateTemperature, "--mutate-temperature", { min: 0 }),
    judge_temperature: numberOption(options.judgeTemperature, "--judge-temperature", { min: 0 })
  };
  const definedAlgorithm = Object.fromEntries(Object.entries(algorithm).filter(([, value]) => value !== undefined));
  if (Object.keys(definedAlgorithm).length > 0) bundle.algorithm = definedAlgorithm;
  return bundle;
}

export async function saveProfileBundle(name: string, bundle: NamedProfileBundle, options: ProfileSaveOptions = {}): Promise<string> {
  assertProfileName(name);
  rejectRawApiKeyFields(bundle, name);
  const dir = profilesDir();
  const target = profilePath(name);
  await mkdir(dir, { recursive: true });
  if (existsSync(target) && !options.force) {
    throw new ConfigError(`Named profile '${name}' already exists at ${target}.`, {
      code: "config.profile_exists",
      retryable: false,
      fix: "Pass --force to overwrite it."
    });
  }

  const yaml = YAML.stringify(bundle);
  await validateWithLoadNamedProfile(yaml);
  if (options.force) {
    await writeProfileOverwrite(target, yaml, name);
  } else {
    await writeProfileCreate(target, yaml, name);
  }
  return target;
}

export function rejectRawApiKeyFlag(options: { apiKey?: string }): void {
  if (options.apiKey !== undefined) {
    throw new ConfigError("Raw --api-key values are not allowed in named profiles.", {
      code: "config.profile_raw_api_key",
      retryable: false,
      fix: "Use --api-key-env to store the environment variable name instead."
    });
  }
}

export function rejectRawApiKeyFields(value: unknown, name: string): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string): void => {
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, inner] of Object.entries(current as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (RAW_API_KEY_RE.test(key)) {
        throw new ConfigError(`Named profile '${name}' must not contain a raw '${key}' value at ${childPath}.`, {
          code: "config.profile_raw_api_key",
          retryable: false,
          fix: "Use api_key_env to reference an environment variable name instead. Raw secrets must not be written to profile files."
        });
      }
      visit(inner, childPath);
    }
  };
  visit(value, "");
}

export function assertProfileName(name: string): void {
  if (!NAMED_PROFILE_NAME_RE.test(name)) {
    throw new ConfigError(`Invalid profile name '${name}'. Names must start with a letter and contain only letters, digits, hyphens, and underscores (max 64 chars).`, {
      code: "config.profile_invalid_name",
      retryable: false,
      fix: "Rename the profile to match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/."
    });
  }
}

function builtInProfile(value: string): "quick" | "balanced" | "paper" {
  if (value === "quick" || value === "balanced" || value === "paper") return value;
  throw new ConfigError(`Unknown built-in profile: ${value}. Use quick, balanced, or paper.`, {
    code: "config.profile_unknown_builtin",
    retryable: false,
    fix: "Pass --profile quick, --profile balanced, or --profile paper."
  });
}

function promptStyleName(value: string): "general" | "paper-programming" {
  if (value === "general" || value === "paper-programming") return value;
  throw new ConfigError(`Unknown prompt style: ${value}. Use general or paper-programming.`, {
    code: "config.prompt_style_unknown",
    retryable: false,
    fix: "Pass --prompt-style general or --prompt-style paper-programming."
  });
}

function numberOption(value: unknown, flag: string, constraints: { integer?: boolean; min?: number } = {}): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (constraints.integer && !Number.isInteger(parsed)) || (constraints.min !== undefined && parsed < constraints.min)) {
    const expectation = constraints.integer ? `an integer${constraints.min !== undefined ? ` >= ${constraints.min}` : ""}` : `a number${constraints.min !== undefined ? ` >= ${constraints.min}` : ""}`;
    throw new ConfigError(`${flag} must be ${expectation}.`, {
      code: "config.profile_invalid_flag",
      retryable: false,
      fix: `Pass ${flag} with ${expectation}.`
    });
  }
  return parsed;
}

function stringOption(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

async function validateWithLoadNamedProfile(yaml: string): Promise<void> {
  const tempName = `ProfileValidate${randomUUID().replaceAll("-", "").slice(0, 32)}`;
  const tempPath = profilePath(tempName);
  await writeFile(tempPath, yaml, { encoding: "utf8", flag: "wx" });
  try {
    await loadNamedProfile(tempName);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function writeProfileCreate(target: string, yaml: string, name: string): Promise<void> {
  try {
    await writeFile(target, yaml, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigError(`Named profile '${name}' already exists at ${target}.`, {
        code: "config.profile_exists",
        retryable: false,
        fix: "Pass --force to overwrite it."
      });
    }
    throw error;
  }
}

async function writeProfileOverwrite(target: string, yaml: string, name: string): Promise<void> {
  const tempPath = join(dirname(target), `.${name}.${randomUUID()}.tmp`);
  await writeFile(tempPath, yaml, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tempPath, target);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
