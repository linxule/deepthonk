import type { Command } from "commander";
import { ConfigError } from "@deepthonk/core";
import {
  PROFILE_SAVE_FLAG_KEYS,
  profileBundleFromFlags,
  readProfileBundleFromConfig,
  rejectRawApiKeyFlag,
  saveProfileBundle,
  type ProfileSaveFlagOptions
} from "./shared.js";

interface SaveOptions extends ProfileSaveFlagOptions {
  fromConfig?: string;
  force?: boolean;
}

export function registerProfileSave(profile: Command): void {
  profile
    .command("save")
    .description("Save a reusable named profile.")
    .argument("<name>")
    .option("--from-config <path>", "Read a YAML config file and save it as a named profile.")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--api-key-env <name>")
    .option("--api-key <value>", "Rejected. Use --api-key-env instead.")
    .option("--generator-model <model>")
    .option("--mutator-model <model>")
    .option("--judge-model <model>")
    .option("--finalizer-model <model>")
    .option("--profile <profile>", "quick|balanced|paper")
    .option("--prompt-style <style>", "general|paper-programming")
    .option("--n <number>")
    .option("--k <number>")
    .option("--t <number>")
    .option("--m <number>")
    .option("--lambda <number>")
    .option("--sample-temperature <number>")
    .option("--mutate-temperature <number>")
    .option("--judge-temperature <number>")
    .option("--force", "Overwrite an existing named profile.")
    .action(async (name, options: SaveOptions) => {
      rejectRawApiKeyFlag(options);
      const bundle = options.fromConfig ? await bundleFromConfigMode(options) : profileBundleFromFlags(options);
      const savedPath = await saveProfileBundle(name, bundle, { force: options.force });
      console.log(savedPath);
    });
}

async function bundleFromConfigMode(options: SaveOptions) {
  const mixedFlags = PROFILE_SAVE_FLAG_KEYS.filter((key) => options[key] !== undefined);
  if (mixedFlags.length > 0) {
    throw new ConfigError(`--from-config cannot be combined with flag-only profile fields: ${mixedFlags.map((key) => `--${kebabCase(key)}`).join(", ")}.`, {
      code: "config.profile_save_mode_conflict",
      retryable: false,
      fix: "Use either --from-config <path> or inline profile flags, not both."
    });
  }
  return readProfileBundleFromConfig(String(options.fromConfig));
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
