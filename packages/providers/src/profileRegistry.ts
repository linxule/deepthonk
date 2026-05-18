import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { ConfigError } from "@deepthonk/core";
import { defaultConfigPath } from "./env.js";

export const NAMED_PROFILE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const RAW_API_KEY_RE = /^api[_-]?key$/i;
export const SECRET_KEY_RE = /^(api[_-]?key|token|secret|password|authorization|bearer|cookie|credential)$/i;

const SECRET_KEY_FIX =
  "Remove raw secret fields from the profile. Rejected key shapes: api_key/api-key, token, secret, password, authorization, bearer, cookie, credential. Use api_key_env to reference an environment variable name instead.";

export interface NamedProfileBundle {
  profile?: "quick" | "balanced" | "paper";
  prompt_style?: "general" | "paper-programming";
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  models?: { generator?: string; mutator?: string; judge?: string; finalizer?: string };
  providers?: Record<string, unknown>;
  algorithm?: Record<string, unknown>;
  prompts?: Record<string, { system?: string; user?: string }>;
  budget?: unknown;
  concurrency?: unknown;
  retry?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

export function profilesDir(): string {
  return process.env.DEEPTHONK_PROFILES_DIR ?? join(dirname(defaultConfigPath), "profiles");
}

export function profilePath(name: string): string {
  return join(profilesDir(), `${name}.yaml`);
}

export async function listProfiles(): Promise<string[]> {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name.replace(/\.yaml$/, ""))
    .sort();
}

export async function loadNamedProfile(name: string): Promise<NamedProfileBundle> {
  validateProfileName(name);
  const path = profilePath(name);
  if (!existsSync(path)) {
    const available = await listProfiles();
    const availableHint = available.length ? `Available profiles: ${available.join(", ")}.` : `No saved profiles yet in ${profilesDir()}.`;
    throw new ConfigError(`Named profile '${name}' not found at ${path}. ${availableHint}`, {
      code: "config.profile_not_found",
      retryable: false,
      fix: `Create ${path} with at least { provider, prompt_style, models.{generator,mutator,judge} } and either profile or algorithm fields. See docs/customization.md for the schema.`
    });
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Named profile '${name}' is not valid YAML: ${(error as Error).message}`, {
      code: "config.profile_invalid_yaml",
      retryable: false,
      fix: `Fix YAML syntax in ${path}.`
    });
  }
  const config = validateNamedProfileValue(parsed, name);
  return config;
}

export function validateNamedProfileBundle(bundle: NamedProfileBundle, name = "profile"): void {
  validateNamedProfileValue(bundle, name);
}

function validateProfileName(name: string): void {
  if (!NAMED_PROFILE_NAME_RE.test(name)) {
    throw new ConfigError(`Invalid profile name '${name}'. Names must start with a letter and contain only letters, digits, hyphens, and underscores (max 64 chars).`, {
      code: "config.profile_invalid_name",
      retryable: false,
      fix: "Rename the profile to match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/."
    });
  }
}

function validateRequiredFields(config: NamedProfileBundle, name: string): void {
  const missing: string[] = [];
  if (!config.profile && !config.algorithm) missing.push("profile (built-in name) or algorithm (block)");
  if (!config.prompt_style) missing.push("prompt_style");
  if (!config.provider) missing.push("provider");
  if (!config.models?.generator) missing.push("models.generator");
  if (!config.models?.mutator) missing.push("models.mutator");
  if (!config.models?.judge) missing.push("models.judge");
  if (missing.length > 0) {
    throw new ConfigError(`Named profile '${name}' is missing required fields: ${missing.join(", ")}.`, {
      code: "config.profile_missing_fields",
      retryable: false,
      fix: "Standalone named profiles must declare the algorithm shape (profile or algorithm block), prompt_style, provider, and at least generator/mutator/judge models. See docs/customization.md."
    });
  }
}

function validateNamedProfileValue(value: unknown, name: string): NamedProfileBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Named profile '${name}' must be a YAML mapping at the top level.`, {
      code: "config.profile_invalid_shape",
      retryable: false,
      fix: `Top-level YAML should have keys like provider, prompt_style, models, algorithm.`
    });
  }
  const config = value as NamedProfileBundle;
  rejectRawApiKeyFields(config, name);
  validateRequiredFields(config, name);
  return config;
}

export function rejectRawApiKeyFields(value: unknown, name = "profile"): void {
  rejectMatchingProfileKeys(value, RAW_API_KEY_RE, "config.profile_raw_api_key", (key, path) => ({
    message: `Named profile '${name}' must not contain a raw '${key}' value at ${path}.`,
    fix: "Use api_key_env to reference an environment variable name instead. Raw secrets must not be written to profile files."
  }));
}

export function rejectAllSecretShapedFields(value: unknown, name = "profile"): void {
  rejectMatchingProfileKeys(value, SECRET_KEY_RE, "config.profile_raw_secret", (key, path) => ({
    message: `Named profile '${name}' must not contain a raw secret-shaped '${key}' value at ${path}.`,
    fix: SECRET_KEY_FIX
  }));
}

function rejectMatchingProfileKeys(
  value: unknown,
  keyPattern: RegExp,
  code: string,
  describe: (key: string, path: string) => { message: string; fix: string }
): void {
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
      if (keyPattern.test(key)) {
        const description = describe(key, childPath);
        throw new ConfigError(description.message, {
          code,
          retryable: false,
          fix: description.fix
        });
      }
      visit(inner, childPath);
    }
  };
  visit(value, "");
}
