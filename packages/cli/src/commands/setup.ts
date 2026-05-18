import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { defaultApiKeyEnv, resolveProviderConfig, resolveProviderModels } from "@deepthonk/providers";
import { defaultConfigPath, defaultEnvPath, resolveCliPath } from "../config.js";

interface SetupConfig {
  profile: string;
  provider: string;
  base_url?: string;
  api_key_env?: string;
  models: {
    generator: string;
    mutator: string;
    judge: string;
    finalizer?: string;
  };
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Create a reusable DeepThonk provider config.")
    .option("--config <yaml>", "Config path to write", defaultConfigPath)
    .option("--key-file <path>", "DeepThonk env file path for --api-key", defaultEnvPath)
    .option("--provider <provider>", "deepseek|openrouter|openai-compatible|fake or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--api-key <key>", "Store API key in the DeepThonk env file instead of the YAML config.")
    .option("--api-key-file <path>", "Read the API key from a local file and store it in the DeepThonk env file.")
    .option("--api-key-stdin", "Read the API key from stdin and store it in the DeepThonk env file.")
    .option("--profile <profile>", "quick|balanced|paper", "balanced")
    .option("--fast-model <model>", "Use one model for generator and mutator.")
    .option("--generator-model <model>")
    .option("--mutator-model <model>")
    .option("--judge-model <model>")
    .option("--finalizer-model <model>")
    .option("--print", "Print config instead of writing files.")
    .action(async (options) => {
      const provider = options.provider ?? inferProvider();
      const apiKeyEnv = options.apiKeyEnv ?? defaultApiKeyEnv(provider) ?? "DEEPTHONK_API_KEY";
      const models = resolveProviderModels(provider, {
        generator: options.generatorModel ?? options.fastModel,
        mutator: options.mutatorModel ?? options.fastModel,
        judge: options.judgeModel,
        finalizer: options.finalizerModel
      });
      const providerConfig = resolveProviderConfig({ provider, baseUrl: options.baseUrl, apiKeyEnv, models });
      const config: SetupConfig = {
        profile: options.profile,
        provider,
        base_url: providerConfig.baseUrl,
        api_key_env: apiKeyEnv,
        models
      };
      if (!config.base_url) delete config.base_url;
      if (!models.finalizer) delete config.models.finalizer;

      const yaml = YAML.stringify(config);
      if (options.print) {
        process.stdout.write(yaml);
        return;
      }

      const configPath = resolveCliPath(options.config);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, yaml, "utf8");

      let envMessage = process.env[apiKeyEnv] ? `Detected ${apiKeyEnv} in the current environment.` : `Set ${apiKeyEnv} before paid runs.`;
      if (options.apiKey && !options.apiKeyStdin && !options.apiKeyFile) {
        process.stderr.write(
          "warning: --api-key exposes the secret via process arguments and shell history. Prefer --api-key-stdin or --api-key-file.\n"
        );
      }
      const apiKey = await resolveApiKey(options);
      if (apiKey) {
        const envPath = resolveCliPath(options.keyFile);
        await mkdir(dirname(envPath), { recursive: true });
        // writeFile mode is only honored at file *creation* on POSIX; the explicit chmod handles
        // the case where the file pre-existed with looser permissions. Do not remove either.
        await writeFile(envPath, `export ${apiKeyEnv}=${shellQuote(apiKey)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(envPath, 0o600);
        envMessage = `Stored ${apiKeyEnv} in ${envPath}.`;
      }

      console.log(
        JSON.stringify(
          {
            config_path: configPath,
            provider,
            api_key_env: apiKeyEnv,
            models,
            env: envMessage,
            usage: `deepthonk run --task task.md --config ${configPath}`
          },
          null,
          2
        )
      );
    });
}

function inferProvider(): string {
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "deepseek";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function resolveApiKey(options: { apiKey?: string; apiKeyFile?: string; apiKeyStdin?: boolean }): Promise<string | undefined> {
  const sources = [options.apiKey, options.apiKeyFile, options.apiKeyStdin ? "stdin" : undefined].filter(Boolean);
  if (sources.length > 1) throw new Error("Use only one of --api-key, --api-key-file, or --api-key-stdin.");
  if (options.apiKeyFile) return (await readFile(resolveCliPath(options.apiKeyFile), "utf8")).trim();
  if (options.apiKeyStdin) return readStdin();
  return options.apiKey;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}
