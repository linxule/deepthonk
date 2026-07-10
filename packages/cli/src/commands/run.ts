import type { Command } from "commander";
import { ConfigError, runDeepThonk } from "@deepthonk/core";
import { createDriver } from "@deepthonk/providers";
import { resolveRunConfig } from "../config.js";
import { redacted } from "../redaction.js";

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Run DeepThonk search.")
    .requiredOption("--task <path-or-inline>")
    .option("--rubric <path-or-inline>")
    .option("--config <yaml>")
    .option("--profile <profile>", "quick|balanced|paper")
    .option("--profile-name <name>", "Load saved bundle from ~/.config/deepthonk/profiles/<name>.yaml")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--generator-model <model>")
    .option("--mutator-model <model>")
    .option("--judge-model <model>")
    .option("--finalizer-model <model>")
    .option("--supports-json-mode <true|false>", "Whether the base OpenAI-compatible provider supports response_format JSON mode")
    .option("--seed <number>")
    .option("--run-id <id>", "Stable caller-supplied run ID (letters, digits, dot, underscore, and hyphen)")
    .option("--out <dir>")
    .option("--max-concurrency <number>")
    .option("--generate-concurrency <number>", "Maximum concurrent generation calls")
    .option("--judge-concurrency <number>", "Maximum concurrent judge calls")
    .option("--mutate-concurrency <number>", "Maximum concurrent mutation calls")
    .option("--max-calls <number>")
    .option("--max-input-tokens <number>")
    .option("--max-output-tokens <number>")
    .option("--max-usd <number>")
    .option("--request-timeout-ms <number>")
    .option("--n <number>", "Population size override (default: profile)")
    .option("--k <number>", "Comparisons per candidate per generation override")
    .option("--t <number>", "Number of mutation generations override")
    .option("--m <number>", "Comparisons per candidate in the final dense ranking round")
    .option("--lambda <number>", "Bradley-Terry L2 regularization override")
    .option("--sample-temperature <number>", "Temperature for initial candidate generation")
    .option("--mutate-temperature <number>", "Temperature for critique-guided mutation")
    .option("--judge-temperature <number>", "Temperature for pairwise judging")
    .option("--prompt-style <style>", "general|paper-programming")
    .option("--prompts <yaml>", "YAML file with per-phase prompt overrides")
    .option("--prompts-json <json>", "Inline JSON object with per-phase prompt overrides")
    .option("--include-prompts", "Store rendered prompts in candidate/comparison metadata")
    .option("--include-raw-model-outputs", "Store raw provider responses in trace metadata")
    .option("--dry-run")
    .action(async (options) => {
      const resolved = await resolveRunConfig(options);
      if (resolved.providerConfig.provider === "sampling") {
        const profileHint = options.profileName
          ? ` The profile '${options.profileName}' selects provider: sampling.`
          : "";
        throw new ConfigError(
          `MCP Sampling provider requires running as an MCP server.${profileHint} Use a direct provider mode (deepseek, openrouter, openai-compatible) for CLI runs, or run via 'deepthonk serve-mcp' with a sampling-capable MCP client.`,
          {
            code: "provider.sampling_requires_mcp",
            retryable: false,
            fix: "Switch to a direct provider via --provider, edit the named profile to use a direct provider, or invoke this work through an MCP host."
          }
        );
      }
      if (options.dryRun) {
        console.log(JSON.stringify(redacted(withApiKeyPresence(resolved)), null, 2));
        return;
      }
      const result = await runDeepThonk(resolved.runConfig, createDriver(resolved.providerConfig));
      console.log(
        JSON.stringify(
          {
            run_id: result.runId,
            run_dir: result.runDir,
            winner_id: result.winner.id,
            calls: result.calls,
            final_answer: result.finalAnswer
          },
          null,
          2
        )
      );
    });
}

function withApiKeyPresence<T extends { providerConfig: { apiKeyEnv?: string; apiKey?: string } }>(value: T): T & { providerConfig: T["providerConfig"] & { apiKeyPresent: boolean } } {
  const apiKeyEnv = value.providerConfig.apiKeyEnv;
  return {
    ...value,
    providerConfig: {
      ...value.providerConfig,
      apiKeyPresent: Boolean(value.providerConfig.apiKey || (apiKeyEnv && process.env[apiKeyEnv]))
    }
  };
}
