import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import YAML from "yaml";
import {
  builtInProfiles,
  claimRunLock,
  ConfigError,
  DeepThonkError,
  getProfile,
  planBudget,
  detectResumeState,
  exportRun,
  isRunCancelRequested,
  mutateCandidate,
  rankCandidates,
  readRunStatus,
  requestRunCancel,
  runDeepThonk,
  TraceStore,
  type BuiltInProfileName,
  type CandidateInput
} from "@deepthonk/core";
import {
  createDriver,
  defaultPricesForProviderConfig,
  listProfiles,
  loadDeepThonkEnv,
  loadNamedProfile,
  NAMED_PROFILE_NAME_RE,
  profilePath,
  profilesDir,
  resolveProviderConfig,
  resolveProviderModels,
  type NamedProfileBundle,
  type ProviderConfig
} from "@deepthonk/providers";
import { recordRunResource } from "./resources.js";

export const toolNames = [
  "deepthonk.plan",
  "deepthonk.start",
  "deepthonk.status",
  "deepthonk.result",
  "deepthonk.cancel",
  "deepthonk.run",
  "deepthonk.rank",
  "deepthonk.mutate",
  "deepthonk.resume",
  "deepthonk.export",
  "deepthonk.profile_list",
  "deepthonk.profile_show",
  "deepthonk.profile_save",
  "deepthonk.profile_delete"
] as const;

export const planArgsSchema = z.object({
  config_path: z.string().optional().describe("Optional DeepThonk YAML config path."),
  profile_name: z.string().optional().describe("Saved profile bundle name; loads ~/.config/deepthonk/profiles/<name>.yaml. Mutually exclusive with config_path."),
  profile: z.enum(["quick", "balanced", "paper"]).default("quick"),
  n: z.number().int().min(2).optional(),
  k: z.number().int().min(1).optional(),
  t: z.number().int().min(0).optional(),
  m: z.number().int().min(1).optional()
});

const providerNameSchema = z
  .string()
  .min(1)
  .describe("Provider label. Built-ins include fake, deepseek, openrouter, and openai-compatible; custom labels require base_url.")
  .refine((provider) => provider !== "sampling", "MCP Sampling is deferred and is not a direct provider option.")
  .default("fake");

export const runArgsSchema = z.object({
  task: z.string().min(1).describe("Task text to solve. MCP tools do not read task files."),
  rubric: z.string().optional().describe("Optional judging rubric text."),
  config_path: z.string().optional().describe("Optional DeepThonk YAML config path, such as ~/.config/deepthonk/config.yaml."),
  profile_name: z.string().optional().describe("Saved profile bundle name; loads ~/.config/deepthonk/profiles/<name>.yaml. Mutually exclusive with config_path."),
  profile: z.enum(["quick", "balanced", "paper"]).default("quick").describe("Run profile. quick is safest for smoke tests; paper plans 285 calls."),
  prompt_style: z.enum(["general", "paper-programming"]).optional().describe("Prompt template style. Defaults to paper-programming for the paper profile, general otherwise."),
  provider: providerNameSchema,
  base_url: z.string().optional().describe("OpenAI-compatible base URL, ending at /v1."),
  api_key_env: z.string().optional().describe("Environment variable that contains the API key."),
  generator_model: z.string().optional().describe("Model used for initial candidate generation."),
  mutator_model: z.string().optional().describe("Model used for critique-guided mutation."),
  judge_model: z.string().optional().describe("Model used for pairwise judging."),
  finalizer_model: z.string().optional().describe("Optional model used to polish the winning candidate."),
  seed: z.number().int().default(1).describe("Deterministic seed for pair ordering and IDs."),
  run_dir: z.string().optional().describe("Directory for trace files."),
  max_calls: z.number().int().optional().describe("Maximum completed provider calls before the run stops at a phase boundary."),
  max_input_tokens: z.number().int().optional().describe("Maximum recorded input tokens before the run stops at a phase boundary."),
  max_output_tokens: z.number().int().optional().describe("Maximum recorded output tokens before the run stops at a phase boundary."),
  max_usd: z.number().optional().describe("Maximum estimated USD spend; requires matching budget.prices in config."),
  request_timeout_ms: z.number().int().optional().describe("Per-request provider timeout in milliseconds."),
  n: z.number().int().min(2).optional().describe("Population size override. Defaults to the profile's n."),
  k: z.number().int().min(1).optional().describe("Comparisons per candidate per mutation-generation round."),
  t: z.number().int().min(0).optional().describe("Number of mutation generations (t=0 disables mutation rounds)."),
  m: z.number().int().min(1).optional().describe("Comparisons per candidate in the final dense ranking round. Mutation count per generation is n - ceil(n/4), not m."),
  lambda: z.number().min(0).optional().describe("Bradley-Terry L2 regularization. Defaults to 0.01."),
  sample_temperature: z.number().min(0).optional().describe("Temperature for initial candidate generation."),
  mutate_temperature: z.number().min(0).optional().describe("Temperature for critique-guided mutation."),
  judge_temperature: z.number().min(0).optional().describe("Temperature for pairwise judging."),
  include_prompts: z.boolean().optional().describe("Store rendered prompts in candidate/comparison metadata."),
  include_raw_model_outputs: z.boolean().optional().describe("Store raw provider responses in trace metadata."),
  concurrency: z.object({
    generate: z.number().int().min(1).optional(),
    judge: z.number().int().min(1).optional(),
    mutate: z.number().int().min(1).optional()
  }).optional().describe("Per-phase concurrency overrides."),
  prompts: z.object({
    generate: z.object({ system: z.string().optional(), user: z.string().optional() }).describe("Variables: {task}, {rubric}").optional(),
    compare: z.object({ system: z.string().optional(), user: z.string().optional() }).describe("Variables: {task}, {rubric}, {candidateA}, {candidateB}. Output must be strict JSON: {feedback_a, feedback_b, winner: A|B|tie}.").optional(),
    mutate: z.object({ system: z.string().optional(), user: z.string().optional() }).describe("Variables: {task}, {rubric}, {candidate}, {critique}").optional(),
    finalize: z.object({ system: z.string().optional(), user: z.string().optional() }).describe("Variables: {task}, {rubric}, {candidate}").optional()
  }).optional().describe("Optional per-phase prompt template overrides. Templates use {task}, {rubric}, {candidate}, {candidateA}, {candidateB}, {critique} placeholders. Use {{ and }} to escape literal braces. See docs/customization.md for the variable contract per phase.")
});

export const jobArgsSchema = z.object({
  run_dir: z.string().min(1).optional().describe("Run directory returned by deepthonk.start or deepthonk.run."),
  job_id: z.string().optional().describe("Job ID returned by deepthonk.start.")
});

const providerArgsSchema = z.object({
  config_path: z.string().optional().describe("Optional DeepThonk YAML config path."),
  profile_name: z.string().optional().describe("Saved profile bundle name; loads ~/.config/deepthonk/profiles/<name>.yaml. Mutually exclusive with config_path."),
  provider: providerNameSchema,
  base_url: z.string().optional().describe("OpenAI-compatible base URL, ending at /v1."),
  api_key_env: z.string().optional().describe("Environment variable that contains the API key."),
  generator_model: z.string().optional().describe("Model used for initial candidate generation."),
  mutator_model: z.string().optional().describe("Model used for critique-guided mutation."),
  judge_model: z.string().optional().describe("Model used for pairwise judging."),
  finalizer_model: z.string().optional().describe("Optional model used to polish the winning candidate.")
});

export const rankArgsSchema = providerArgsSchema.extend({
  task: z.string().min(1).describe("Task text the candidates answer."),
  rubric: z.string().optional().describe("Optional judging rubric text."),
  candidates: z.array(z.union([z.string(), z.object({ id: z.string().optional(), content: z.string() })])).min(2).describe("Candidate texts or {id, content} objects."),
  judge_temperature: z.number().min(0).optional().describe("Temperature for pairwise judging."),
  lambda: z.number().min(0).optional().describe("Bradley-Terry L2 regularization."),
  concurrency: z.number().int().min(1).optional().describe("Maximum concurrent pairwise comparisons."),
  prompt_style: z.enum(["general", "paper-programming"]).optional(),
  prompts: z.object({
    compare: z.object({ system: z.string().optional(), user: z.string().optional() }).describe("Variables: {task}, {rubric}, {candidateA}, {candidateB}. Output must be strict JSON: {feedback_a, feedback_b, winner: A|B|tie}.").optional()
  }).optional()
});

export const mutateArgsSchema = providerArgsSchema.extend({
  task: z.string().min(1).describe("Task text the candidate answers."),
  rubric: z.string().optional().describe("Optional rubric text."),
  candidate: z.string().describe("Candidate text to mutate."),
  critique: z.string().default("").describe("Critique or guidance for mutation."),
  mutate_temperature: z.number().min(0).optional().describe("Temperature for mutation."),
  prompt_style: z.enum(["general", "paper-programming"]).optional(),
  prompts: z.object({
    mutate: z.object({ system: z.string().optional(), user: z.string().optional() }).describe("Variables: {task}, {rubric}, {candidate}, {critique}").optional()
  }).optional()
});

export const resumeArgsSchema = z.object({
  run_dir: z.string()
});

export const exportArgsSchema = z.object({
  run_dir: z.string(),
  format: z.enum(["json", "markdown", "jsonl"]).default("json")
});

export const runOutputSchema = z.object({
  run_id: z.string(),
  winner_id: z.string(),
  final_answer: z.string(),
  summary_resource: z.string(),
  trace_resource: z.string(),
  run_dir: z.string()
});

export const startOutputSchema = z.object({
  job_id: z.string(),
  run_dir: z.string(),
  state: z.string(),
  status_resource: z.string(),
  result_resource: z.string()
});

export const statusOutputSchema = z.object({
  job_id: z.string().optional(),
  run_id: z.string().optional(),
  run_dir: z.string().optional(),
  state: z.string().optional(),
  status: z.string().optional(),
  phase: z.string().optional(),
  generation: z.union([z.number(), z.literal("final")]).optional(),
  usage: z.object({}).passthrough().optional(),
  error: z.object({}).passthrough().optional(),
  message: z.string().optional()
}).passthrough();
export const resultOutputSchema = z.object({ complete: z.boolean().optional(), run_id: z.string().optional(), run_dir: z.string().optional() }).passthrough();
export const cancelOutputSchema = z.object({ cancel_requested: z.boolean(), run_dir: z.string().optional() }).passthrough();
export const resumeOutputSchema = z.object({
  status: z.string(),
  message: z.string(),
  run_id: z.string().optional(),
  phase: z.string().optional(),
  generation: z.union([z.number(), z.literal("final")]).optional(),
  safe_to_continue: z.boolean().optional()
});

export const rankOutputSchema = z.object({
  scores: z.array(z.object({}).passthrough()),
  comparisons: z.array(z.object({}).passthrough())
});

export const mutateOutputSchema = z.object({
  mutated: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  usage: z.object({}).passthrough().optional()
});

export function deepthonkPlan(argsInput: unknown): Record<string, unknown> {
  const args = planArgsSchema.parse(argsInput);
  if (args.config_path === undefined && args.profile_name === undefined && args.n === undefined && args.k === undefined && args.t === undefined && args.m === undefined) {
    return planBudget(args.profile) as unknown as Record<string, unknown>;
  }
  if (args.config_path !== undefined || args.profile_name !== undefined) {
    throw new ConfigError("deepthonk.plan with config_path or profile_name is async; use deepthonkPlanAsync.", {
      code: "mcp.plan_async_required",
      retryable: false
    });
  }
  const base = builtInProfiles[args.profile];
  return planBudget({
    ...base,
    n: args.n ?? base.n,
    k: args.k ?? base.k,
    t: args.t ?? base.t,
    m: args.m ?? base.m
  }) as unknown as Record<string, unknown>;
}

export async function deepthonkPlanAsync(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = planArgsSchema.parse(argsInput);
  const config = await readMcpConfig(args.config_path, args.profile_name);
  const profileName = config.profile ?? args.profile;
  const base = builtInProfiles[profileName];
  return planBudget({
    ...base,
    n: args.n ?? config.algorithm?.n ?? base.n,
    k: args.k ?? config.algorithm?.k ?? base.k,
    t: args.t ?? config.algorithm?.t ?? base.t,
    m: args.m ?? config.algorithm?.m ?? base.m,
    lambda: config.algorithm?.lambda ?? base.lambda,
    sampleTemperature: config.algorithm?.sample_temperature ?? base.sampleTemperature,
    mutateTemperature: config.algorithm?.mutate_temperature ?? base.mutateTemperature,
    judgeTemperature: config.algorithm?.judge_temperature ?? base.judgeTemperature
  }) as unknown as Record<string, unknown>;
}

export async function deepthonkStart(argsInput: unknown): Promise<Record<string, unknown>> {
  const { runConfig, providerConfig } = await resolveMcpRun(argsInput);
  const jobId = `job_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(16).slice(2, 8)}`;
  const now = new Date().toISOString();
  const claimed = await claimRunLock(runConfig.runDir, jobId);
  if (!claimed) {
    const existing = await readRunStatus(runConfig.runDir);
    if (existing?.job_id && (existing.state === "pending" || existing.state === "running")) {
      return {
        job_id: existing.job_id,
        run_dir: runConfig.runDir,
        state: existing.state,
        status_resource: `deepthonk://jobs/${existing.job_id}/status?run_dir=${encodeURIComponent(runConfig.runDir)}`,
        result_resource: `deepthonk://jobs/${existing.job_id}/result?run_dir=${encodeURIComponent(runConfig.runDir)}`
      };
    }
    throw new ConfigError(`Run directory is already claimed: ${runConfig.runDir}`, {
      code: "run.directory_locked",
      retryable: false,
      fix: "Use a fresh run_dir or inspect the existing run status."
    });
  }
  await new TraceStore(runConfig.runDir).writeStatus({
    job_id: jobId,
    run_dir: runConfig.runDir,
    state: "pending",
    phase: "queued",
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    started_at: now,
    updated_at: now
  });
  void runDeepThonk(runConfig, createDriver(providerConfig), {
    jobId,
    shouldCancel: () => isRunCancelRequested(runConfig.runDir)
  })
    .then(async (result) => {
      try {
        await recordRunResource(result.runId, result.runDir);
      } catch (writeErr) {
        process.stderr.write(`deepthonk: failed to record run resource: ${(writeErr as Error).message}\n`);
      }
    })
    .catch(async (error) => {
      try {
        const existing = await readRunStatus(runConfig.runDir);
        if (existing && ["completed", "failed", "cancelled", "budget_exceeded"].includes(existing.state)) return;
        const serialized = serializeToolError(error, runConfig.runDir);
        await new TraceStore(runConfig.runDir).writeStatus({
          job_id: jobId,
          run_dir: runConfig.runDir,
          state: "failed",
          phase: "failed",
          usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          started_at: now,
          updated_at: new Date().toISOString(),
          error: {
            code: String(serialized.code),
            message: String(serialized.message),
            retryable: Boolean(serialized.retryable),
            fix: typeof serialized.fix === "string" ? serialized.fix : undefined
          }
        });
      } catch (writeErr) {
        process.stderr.write(`deepthonk: failed to persist failure status: ${(writeErr as Error).message}\n`);
      }
    });
  return {
    job_id: jobId,
    run_dir: runConfig.runDir,
    state: "pending",
    status_resource: `deepthonk://jobs/${jobId}/status?run_dir=${encodeURIComponent(runConfig.runDir)}`,
    result_resource: `deepthonk://jobs/${jobId}/result?run_dir=${encodeURIComponent(runConfig.runDir)}`
  };
}

export async function deepthonkStatus(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = jobArgsSchema.parse(argsInput);
  const runDir = await resolveJobRunDir(args);
  const status = await readRunStatus(runDir);
  if (args.job_id && status?.job_id && args.job_id !== status.job_id) throw jobMismatch(args.job_id, status.job_id);
  if (status) return { ...status };
  return { ...(await detectResumeState(runDir)), run_dir: runDir };
}

export async function deepthonkResult(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = jobArgsSchema.parse(argsInput);
  const runDir = await resolveJobRunDir(args);
  const status = await readRunStatus(runDir);
  if (args.job_id && status?.job_id && args.job_id !== status.job_id) throw jobMismatch(args.job_id, status.job_id);
  const resume = await detectResumeState(runDir);
  if (resume.status !== "completed") {
    return {
      complete: false,
      run_dir: runDir,
      status: status ?? resume
    };
  }
  const summary = await exportRun(runDir, "json");
  const runId = typeof summary.run_id === "string" ? summary.run_id : status?.run_id;
  if (runId) await recordRunResource(runId, runDir);
  return {
    complete: true,
    run_id: runId,
    run_dir: runDir,
    summary,
    summary_resource: runId ? `deepthonk://runs/${runId}/summary` : undefined,
    trace_resource: runId ? `deepthonk://runs/${runId}/trace` : undefined
  };
}

export async function deepthonkCancel(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = jobArgsSchema.parse(argsInput);
  const runDir = await resolveJobRunDir(args);
  const status = await readRunStatus(runDir);
  if (args.job_id && status?.job_id && args.job_id !== status.job_id) throw jobMismatch(args.job_id, status.job_id);
  await requestRunCancel(runDir);
  return {
    cancel_requested: true,
    run_dir: runDir,
    status: (await readRunStatus(runDir)) ?? { state: "cancel_requested", phase: "cancel_requested" }
  };
}

export async function deepthonkRun(argsInput: unknown): Promise<Record<string, unknown>> {
  const { runConfig, providerConfig } = await resolveMcpRun(argsInput);
  const result = await runDeepThonk(runConfig, createDriver(providerConfig), {
    shouldCancel: () => isRunCancelRequested(runConfig.runDir)
  });
  await recordRunResource(result.runId, result.runDir);
  return {
    run_id: result.runId,
    winner_id: result.winner.id,
    final_answer: result.finalAnswer,
    summary_resource: `deepthonk://runs/${result.runId}/summary`,
    trace_resource: `deepthonk://runs/${result.runId}/trace`,
    run_dir: result.runDir
  };
}

async function resolveMcpRun(argsInput: unknown): Promise<{ runConfig: Parameters<typeof runDeepThonk>[0]; providerConfig: ProviderConfig }> {
  const raw = objectInput(argsInput);
  const args = runArgsSchema.parse(argsInput);
  const config = await readMcpConfig(args.config_path, args.profile_name);
  const profileName = (raw.profile ?? config.profile ?? args.profile) as BuiltInProfileName;
  const baseProfile = getProfile(profileName);
  const profile = mergeProfileOverrides(baseProfile, config.algorithm, args);
  const providerConfig = resolveMcpProviderConfig(args, raw, config);
  const models = providerConfig.models;
  const runDir = args.run_dir ?? `runs/mcp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const promptOverrides = mergePromptOverrides(config.prompts, args.prompts);
  return {
    runConfig: {
      task: args.task,
      rubric: args.rubric,
      promptStyle: args.prompt_style ?? config.prompt_style ?? (profileName === "paper" ? "paper-programming" : "general"),
      promptOverrides,
      profile,
      runDir,
      seed: args.seed,
      provider: providerConfig.provider,
      generatorModel: models.generator,
      mutatorModel: models.mutator,
      judgeModel: models.judge,
      finalizerModel: models.finalizer,
      concurrency: {
        generate: args.concurrency?.generate ?? config.concurrency?.generate ?? profile.n,
        judge: args.concurrency?.judge ?? config.concurrency?.judge ?? Math.max(1, (profile.n * Math.max(profile.k, profile.m)) / 2),
        mutate: args.concurrency?.mutate ?? config.concurrency?.mutate ?? profile.n - Math.floor(profile.n / 4)
      },
      retry: {
        httpRetries: config.retry?.httpRetries ?? 2,
        invalidJsonRetries: config.retry?.invalidJsonRetries ?? 1,
        requestTimeoutMs: args.request_timeout_ms ?? config.retry?.requestTimeoutMs
      },
      budget: mergeBudget(config.budget, {
        maxCalls: args.max_calls,
        maxInputTokens: args.max_input_tokens,
        maxOutputTokens: args.max_output_tokens,
        maxUsd: args.max_usd
      }, defaultPricesForProviderConfig(providerConfig)),
      output: {
        includeRawModelOutputs: args.include_raw_model_outputs ?? config.output?.includeRawModelOutputs ?? false,
        includePrompts: args.include_prompts ?? config.output?.includePrompts ?? false
      }
    },
    providerConfig
  };
}

export async function deepthonkRank(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = rankArgsSchema.parse(argsInput);
  const providerConfig = await providerConfigFromArgs(args);
  const models = providerConfig.models;
  const driver = createDriver(providerConfig);
  const candidates: CandidateInput[] = args.candidates;
  const result = await rankCandidates({
    task: args.task,
    rubric: args.rubric,
    candidates,
    driver,
    judgeModel: models.judge,
    runId: "mcp-rank",
    temperature: args.judge_temperature,
    lambda: args.lambda,
    concurrency: args.concurrency,
    promptStyle: args.prompt_style,
    promptOverrides: args.prompts
  });
  return { scores: result.scores, comparisons: result.comparisons };
}

export async function deepthonkMutate(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = mutateArgsSchema.parse(argsInput);
  const providerConfig = await providerConfigFromArgs(args);
  const models = providerConfig.models;
  return {
    ...(await mutateCandidate({
      task: args.task,
      rubric: args.rubric,
      candidate: { id: "mcp-candidate", content: args.candidate },
      driver: createDriver(providerConfig),
      mutatorModel: models.mutator,
      temperature: args.mutate_temperature,
      critique: args.critique,
      promptStyle: args.prompt_style,
      promptOverrides: args.prompts
    }))
  };
}

export async function deepthonkResume(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = resumeArgsSchema.parse(argsInput);
  return { ...(await detectResumeState(args.run_dir)) };
}

export async function deepthonkExport(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = exportArgsSchema.parse(argsInput);
  return exportRun(args.run_dir, args.format);
}

async function providerConfigFromArgs(args: z.infer<typeof providerArgsSchema>): Promise<ProviderConfig> {
  const config = await readMcpConfig(args.config_path, args.profile_name);
  return resolveMcpProviderConfig(args, objectInput(args), config);
}

function resolveMcpProviderConfig(
  args: z.infer<typeof providerArgsSchema>,
  raw: Record<string, unknown>,
  config: RawMcpConfig
): ProviderConfig {
  const provider = String(raw.provider ?? config.provider ?? args.provider);
  return resolveProviderConfig({
    provider,
    baseUrl: args.base_url ?? config.base_url,
    apiKeyEnv: args.api_key_env ?? config.api_key_env,
    models: {
      generator: args.generator_model ?? config.models?.generator,
      mutator: args.mutator_model ?? config.models?.mutator,
      judge: args.judge_model ?? config.models?.judge,
      finalizer: args.finalizer_model ?? config.models?.finalizer
    },
    roleProviders: normalizeRoleProviders(config.providers, resolveProviderModels(provider, {
      generator: args.generator_model ?? config.models?.generator,
      mutator: args.mutator_model ?? config.models?.mutator,
      judge: args.judge_model ?? config.models?.judge,
      finalizer: args.finalizer_model ?? config.models?.finalizer
    })),
    retry: { httpRetries: 2, requestTimeoutMs: config.retry?.requestTimeoutMs }
  });
}

export function toolResult(value: unknown): { structuredContent: Record<string, unknown>; content: Array<{ type: "text"; text: string }> } {
  const structuredContent = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { structuredContent, content: [{ type: "text", text: summarizeToolResult(structuredContent) }] };
}

export function toolError(error: unknown, runDir?: string): {
  isError: true;
  structuredContent: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
} {
  const structuredContent = serializeToolError(error, runDir);
  return { isError: true, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
}

interface RawMcpConfig {
  profile?: BuiltInProfileName;
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  models?: { generator?: string; mutator?: string; judge?: string; finalizer?: string };
  providers?: Record<string, { provider?: string; base_url?: string; api_key_env?: string; model?: string; supports_json_mode?: boolean }>;
  concurrency?: Partial<Parameters<typeof runDeepThonk>[0]["concurrency"]>;
  retry?: Partial<Parameters<typeof runDeepThonk>[0]["retry"]>;
  budget?: Parameters<typeof runDeepThonk>[0]["budget"];
  output?: Partial<Parameters<typeof runDeepThonk>[0]["output"]>;
  prompt_style?: Parameters<typeof runDeepThonk>[0]["promptStyle"];
  algorithm?: McpAlgorithmOverrides;
  prompts?: McpPromptOverrides;
}

interface McpPromptOverrides {
  generate?: { system?: string; user?: string };
  compare?: { system?: string; user?: string };
  mutate?: { system?: string; user?: string };
  finalize?: { system?: string; user?: string };
}

function mergePromptOverrides(
  fileOverrides: McpPromptOverrides | undefined,
  argOverrides: z.infer<typeof runArgsSchema>["prompts"]
): Parameters<typeof runDeepThonk>[0]["promptOverrides"] {
  if (!fileOverrides && !argOverrides) return undefined;
  const merged: McpPromptOverrides = { ...(fileOverrides ?? {}) };
  if (argOverrides) {
    for (const phase of ["generate", "compare", "mutate", "finalize"] as const) {
      if (argOverrides[phase]) merged[phase] = { ...(merged[phase] ?? {}), ...argOverrides[phase] };
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

interface McpAlgorithmOverrides {
  n?: number;
  k?: number;
  t?: number;
  m?: number;
  lambda?: number;
  sample_temperature?: number;
  mutate_temperature?: number;
  judge_temperature?: number;
}

function mergeProfileOverrides(
  base: Parameters<typeof runDeepThonk>[0]["profile"],
  fileOverrides: McpAlgorithmOverrides | undefined,
  args: z.infer<typeof runArgsSchema>
): Parameters<typeof runDeepThonk>[0]["profile"] {
  return {
    n: args.n ?? fileOverrides?.n ?? base.n,
    k: args.k ?? fileOverrides?.k ?? base.k,
    t: args.t ?? fileOverrides?.t ?? base.t,
    m: args.m ?? fileOverrides?.m ?? base.m,
    lambda: args.lambda ?? fileOverrides?.lambda ?? base.lambda,
    sampleTemperature: args.sample_temperature ?? fileOverrides?.sample_temperature ?? base.sampleTemperature,
    mutateTemperature: args.mutate_temperature ?? fileOverrides?.mutate_temperature ?? base.mutateTemperature,
    judgeTemperature: args.judge_temperature ?? fileOverrides?.judge_temperature ?? base.judgeTemperature
  };
}

async function readMcpConfig(path?: string, profileName?: string): Promise<RawMcpConfig> {
  await loadDeepThonkEnv();
  if (profileName) {
    if (path) {
      throw new ConfigError("profile_name and config_path cannot be used together. A named profile replaces the config file.", {
        code: "config.profile_and_config_conflict",
        retryable: false,
        fix: "Choose one: profile_name to load a saved bundle, or config_path to point at a config YAML."
      });
    }
    return (await loadNamedProfile(profileName)) as RawMcpConfig;
  }
  if (!path) return {};
  return YAML.parse(await readFile(resolveMcpPath(path), "utf8")) as RawMcpConfig;
}

async function resolveJobRunDir(args: z.infer<typeof jobArgsSchema>): Promise<string> {
  if (args.run_dir) return args.run_dir;
  throw new ConfigError(`Job lookup by job_id is not available without run_dir: ${args.job_id}`, {
    code: "mcp.job_not_found",
    retryable: false,
    fix: "Pass run_dir from deepthonk.start, or use the returned job resource URI."
  });
}

function jobMismatch(requested: string, actual: string): ConfigError {
  return new ConfigError(`Job ID mismatch: requested ${requested}, run directory belongs to ${actual}.`, {
    code: "mcp.job_mismatch",
    retryable: false,
    fix: "Use the job_id returned with this run_dir."
  });
}

function resolveMcpPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}

function normalizeRoleProviders(
  providers: RawMcpConfig["providers"],
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

function mergeBudget(
  fileBudget: Parameters<typeof runDeepThonk>[0]["budget"],
  overrides: Partial<NonNullable<Parameters<typeof runDeepThonk>[0]["budget"]>>,
  defaultPrices: NonNullable<NonNullable<Parameters<typeof runDeepThonk>[0]["budget"]>["prices"]> = []
): Parameters<typeof runDeepThonk>[0]["budget"] {
  const prices = mergePrices(defaultPrices, fileBudget?.prices);
  const definedOverrides = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  if (!fileBudget && !Object.keys(definedOverrides).length && prices.length === 0) return undefined;
  const merged = {
    ...(fileBudget ?? {}),
    ...definedOverrides,
    prices
  } as Parameters<typeof runDeepThonk>[0]["budget"];
  return merged && Object.keys(merged).length ? merged : undefined;
}

function mergePrices(
  defaults: NonNullable<NonNullable<Parameters<typeof runDeepThonk>[0]["budget"]>["prices"]>,
  overrides: NonNullable<NonNullable<Parameters<typeof runDeepThonk>[0]["budget"]>["prices"]> | undefined
): NonNullable<NonNullable<Parameters<typeof runDeepThonk>[0]["budget"]>["prices"]> {
  const byKey = new Map(defaults.map((price) => [`${price.provider}/${price.model}`, price]));
  for (const price of overrides ?? []) byKey.set(`${price.provider}/${price.model}`, price);
  return [...byKey.values()];
}

function objectInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function summarizeToolResult(value: Record<string, unknown>): string {
  if (typeof value.job_id === "string") return `job_id=${value.job_id}\nrun_dir=${String(value.run_dir)}\nstate=${String(value.state)}`;
  if (typeof value.run_id === "string") {
    return `run_id=${value.run_id}\nwinner_id=${String(value.winner_id)}\nsummary_resource=${String(value.summary_resource)}\ntrace_resource=${String(value.trace_resource)}`;
  }
  if (typeof value.markdown === "string") return value.markdown.slice(0, 2000);
  if (typeof value.jsonl === "string") return `jsonl_bytes=${value.jsonl.length}`;
  return JSON.stringify(value, null, 2).slice(0, 2000);
}

function serializeToolError(error: unknown, runDir?: string): Record<string, unknown> {
  if (error instanceof DeepThonkError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fix: error.fix,
      run_dir: runDir
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "mcp.invalid_arguments",
      message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      retryable: false,
      fix: "Fix the tool arguments and retry.",
      run_dir: runDir
    };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    run_dir: runDir
  };
}

export const profileListArgsSchema = z.object({});
export const profileNameArgsSchema = z.object({
  name: z.string().min(1)
});
export const profileSaveArgsSchema = z.object({
  name: z.string().min(1),
  force: z.boolean().optional(),
  profile: z.enum(["quick", "balanced", "paper"]).optional(),
  prompt_style: z.enum(["general", "paper-programming"]).optional(),
  provider: z.string().min(1).optional(),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  models: z.object({
    generator: z.string().optional(),
    mutator: z.string().optional(),
    judge: z.string().optional(),
    finalizer: z.string().optional()
  }).optional(),
  providers: z.record(z.unknown()).optional(),
  algorithm: z.record(z.unknown()).optional(),
  prompts: z.record(z.object({ system: z.string().optional(), user: z.string().optional() })).optional(),
  budget: z.unknown().optional(),
  concurrency: z.unknown().optional(),
  retry: z.unknown().optional(),
  output: z.unknown().optional()
}).passthrough();

export const profileListOutputSchema = z.object({
  profiles: z.array(z.string())
});
export const profileShowOutputSchema = z.object({
  profile: z.object({}).passthrough()
});
export const profileSaveOutputSchema = z.object({
  path: z.string()
});
export const profileDeleteOutputSchema = z.object({
  deleted: z.string()
});

export async function deepthonkProfileList(_argsInput: unknown): Promise<Record<string, unknown>> {
  profileListArgsSchema.parse(_argsInput ?? {});
  return { profiles: await listProfiles() };
}

export async function deepthonkProfileShow(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = profileNameArgsSchema.parse(argsInput);
  return { profile: redactedProfile(await loadNamedProfile(args.name)) as Record<string, unknown> };
}

export async function deepthonkProfileSave(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = profileSaveArgsSchema.parse(argsInput);
  const { name, force, ...profile } = args;
  const path = await saveMcpProfileBundle(name, stripUndefined(profile) as NamedProfileBundle, Boolean(force));
  return { path };
}

export async function deepthonkProfileDelete(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = profileNameArgsSchema.parse(argsInput);
  await loadNamedProfile(args.name);
  const path = profilePath(args.name);
  await unlink(path);
  return { deleted: path };
}

const MCP_SECRET_KEY_RE = /^(api[_-]?key|token|secret|password|authorization|bearer|cookie|credential)$/i;
const MCP_RAW_API_KEY_RE = /^api[_-]?key$/i;

function redactedProfile(value: unknown): unknown {
  const serialized = JSON.stringify(value, (key, inner) => {
    if (MCP_SECRET_KEY_RE.test(key) && inner) return "[redacted]";
    return inner;
  });
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

async function saveMcpProfileBundle(name: string, bundle: NamedProfileBundle, force: boolean): Promise<string> {
  assertMcpProfileName(name);
  rejectMcpRawApiKeyFields(bundle, name);
  const dir = profilesDir();
  const target = profilePath(name);
  await mkdir(dir, { recursive: true });
  if (existsSync(target) && !force) {
    throw new ConfigError(`Named profile '${name}' already exists at ${target}.`, {
      code: "config.profile_exists",
      retryable: false,
      fix: "Pass force: true to overwrite it."
    });
  }

  const yaml = YAML.stringify(bundle);
  await validateMcpProfileWithLoadNamedProfile(yaml);
  if (force) {
    await writeMcpProfileOverwrite(target, yaml, name);
  } else {
    await writeMcpProfileCreate(target, yaml, name);
  }
  return target;
}

function assertMcpProfileName(name: string): void {
  if (!NAMED_PROFILE_NAME_RE.test(name)) {
    throw new ConfigError(`Invalid profile name '${name}'. Names must start with a letter and contain only letters, digits, hyphens, and underscores (max 64 chars).`, {
      code: "config.profile_invalid_name",
      retryable: false,
      fix: "Rename the profile to match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/."
    });
  }
}

function rejectMcpRawApiKeyFields(value: unknown, name: string): void {
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
      if (MCP_RAW_API_KEY_RE.test(key)) {
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

async function validateMcpProfileWithLoadNamedProfile(yaml: string): Promise<void> {
  const tempName = `ProfileValidate${randomUUID().replaceAll("-", "").slice(0, 32)}`;
  const tempPath = profilePath(tempName);
  await writeFile(tempPath, yaml, { encoding: "utf8", flag: "wx" });
  try {
    await loadNamedProfile(tempName);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function writeMcpProfileCreate(target: string, yaml: string, name: string): Promise<void> {
  try {
    await writeFile(target, yaml, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigError(`Named profile '${name}' already exists at ${target}.`, {
        code: "config.profile_exists",
        retryable: false,
        fix: "Pass force: true to overwrite it."
      });
    }
    throw error;
  }
}

async function writeMcpProfileOverwrite(target: string, yaml: string, name: string): Promise<void> {
  const tempPath = join(dirname(target), `.${name}.${randomUUID()}.tmp`);
  await writeFile(tempPath, yaml, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tempPath, target);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .map(([key, inner]) => [key, stripUndefined(inner)])
  );
}
