import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import YAML from "yaml";
import {
  builtInProfiles,
  claimRunLockOwnership,
  ConfigError,
  DeepThonkError,
  getProfile,
  planBudget,
  detectResumeState,
  exportRun,
  isRunCancelRequested,
  inspectRunLock,
  releaseRunLock,
  reclaimRunLock,
  repairLegacyBudgetConfig,
  mutateCandidate,
  rankCandidates,
  readRunStatus,
  requestRunCancel,
  resumeDeepThonk,
  runIdSchema,
  runConfigSchema,
  runDeepThonk,
  TraceStore,
  type BuiltInProfileName,
  type CandidateInput,
  type RunLockClaim
} from "@deepthonk/core";
import {
  createDriver,
  defaultPricesForProviderConfig,
  type ExternalConfigFile,
  listProfiles,
  loadDeepThonkEnv,
  loadNamedProfile,
  NAMED_PROFILE_NAME_RE,
  normalizeExternalConfig,
  profilePath,
  profilesDir,
  parseProviderReplay,
  providerConfigFromReplay,
  providerReplayFromConfig,
  rejectAllSecretShapedFields,
  rejectRawApiKeyFields,
  resolveProviderConfig,
  SECRET_KEY_RE,
  type NamedProfileBundle,
  type ProviderConfig,
  type SamplingTransport,
  validateNamedProfileBundle
} from "@deepthonk/providers";
import { jobArtifactResources, MAX_RESOURCE_BYTES, recordRunResource } from "./resources.js";

export const toolNames = [
  "deepthonk.plan",
  "deepthonk.start",
  "deepthonk.status",
  "deepthonk.result",
  "deepthonk.cancel",
  "deepthonk.lock_inspect",
  "deepthonk.lock_reclaim",
  "deepthonk.repair_budget",
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
  .default("fake");

const modelOutputTokensArgsSchema = z.object({
  generation: z.number().int().min(1).optional(),
  mutation: z.number().int().min(1).optional(),
  judge: z.number().int().min(1).optional(),
  finalizer: z.number().int().min(1).optional()
}).strict();

const rankControlArgsSchema = z.object({
  mode: z.enum(["all-pairs", "k-regular"]),
  k: z.number().int().min(1).optional(),
  seed: z.number().int().optional(),
  max_calls: z.number().int().min(1).optional()
}).strict();

export const runArgsSchema = z.object({
  task: z.string().min(1).describe("Task text to solve. MCP tools do not read task files."),
  run_id: runIdSchema.optional().describe("Optional stable caller-supplied run ID."),
  rubric: z.string().optional().describe("Optional judging rubric text."),
  config_path: z.string().optional().describe("Optional DeepThonk YAML config path, such as ~/.config/deepthonk/config.yaml."),
  profile_name: z.string().optional().describe("Saved profile bundle name; loads ~/.config/deepthonk/profiles/<name>.yaml. Mutually exclusive with config_path."),
  profile: z.enum(["quick", "balanced", "paper"]).default("quick").describe("Run profile. quick is safest for smoke tests; paper plans 285 calls."),
  prompt_style: z.enum(["general", "paper-programming"]).optional().describe("Prompt template style. Defaults to paper-programming for the paper profile, general otherwise."),
  provider: providerNameSchema,
  base_url: z.string().optional().describe("OpenAI-compatible base URL, ending at /v1."),
  api_key_env: z.string().optional().describe("Environment variable that contains the API key."),
  supports_json_mode: z.boolean().optional().describe("Whether the base OpenAI-compatible provider supports response_format JSON mode."),
  generator_model: z.string().optional().describe("Model used for initial candidate generation."),
  mutator_model: z.string().optional().describe("Model used for critique-guided mutation."),
  judge_model: z.string().optional().describe("Model used for pairwise judging."),
  finalizer_model: z.string().optional().describe("Optional model used to polish the winning candidate."),
  sampling_model_hints: z.array(z.string()).optional().describe("Optional MCP Sampling model hints. Hints guide host model choice but do not enforce it."),
  sampling_cost_priority: z.number().min(0).max(1).optional().describe("MCP Sampling model preference for lower cost, from 0 to 1."),
  sampling_speed_priority: z.number().min(0).max(1).optional().describe("MCP Sampling model preference for speed, from 0 to 1."),
  sampling_intelligence_priority: z.number().min(0).max(1).optional().describe("MCP Sampling model preference for intelligence, from 0 to 1."),
  seed: z.number().int().default(1).describe("Deterministic seed for pair ordering and IDs."),
  run_dir: z.string().optional().describe("Directory for trace files."),
  max_calls: z.number().int().min(1).optional().describe("Maximum logical model invocations, including failed calls and invalid-JSON retries; internal HTTP retries are reported separately."),
  max_input_tokens: z.number().int().min(1).optional().describe("Maximum recorded input tokens before the run stops at a phase boundary."),
  max_output_tokens: z.number().int().min(1).optional().describe("Maximum recorded output tokens before the run stops at a phase boundary."),
  max_usd: z.number().min(0).optional().describe("Maximum estimated USD spend; requires matching budget.prices in config."),
  request_timeout_ms: z.number().int().min(1).optional().describe("Logical provider-call deadline in milliseconds, including body reads and retry waits."),
  provider_max_concurrency: z.number().int().min(1).max(1_024).optional().describe("Process-shared maximum concurrent calls to this provider route."),
  model_output_tokens: modelOutputTokensArgsSchema.optional().describe("Per-role model output token caps."),
  critique_limits: z.object({ aggregate_chars: z.number().int().min(256).optional() }).strict().optional().describe("Critique aggregation bounds."),
  rank: rankControlArgsSchema.optional().describe("Final ranking mode, degree, seed, and logical-call limit."),
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

export const lockInspectArgsSchema = z.object({
  run_dir: z.string().min(1).describe("Run directory containing the lock to inspect.")
});

export const lockReclaimArgsSchema = lockInspectArgsSchema.extend({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).describe("Exact fingerprint returned by deepthonk.lock_inspect.")
});

export const lockInspectOutputSchema = z.object({
  run_dir: z.string(),
  state: z.enum(["missing", "valid", "malformed"]),
  fingerprint: z.string().optional(),
  lock: z.object({}).passthrough().optional(),
  sameHost: z.boolean().optional(),
  workerAlive: z.boolean().optional()
});

export const lockReclaimOutputSchema = z.object({
  run_dir: z.string(),
  fingerprint: z.string(),
  reclaimed: z.boolean()
});

const repairBudgetPath = /^budget\.(?:maxCalls|maxInputTokens|maxOutputTokens)$|^budget\.prices\.\d+\.longContextThresholdTokens$/;
export const repairBudgetArgsSchema = z.object({
  run_dir: z.string().min(1),
  replacements: z.record(z.string(), z.number().int().positive()).refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).every((path) => repairBudgetPath.test(path)),
    "Replacement keys must be exact legacy-redacted budget paths."
  )
});
export const repairBudgetOutputSchema = z.object({ run_dir: z.string(), repaired: z.array(z.string()) });

const providerArgsSchema = z.object({
  config_path: z.string().optional().describe("Optional DeepThonk YAML config path."),
  profile_name: z.string().optional().describe("Saved profile bundle name; loads ~/.config/deepthonk/profiles/<name>.yaml. Mutually exclusive with config_path."),
  profile: z.enum(["quick", "balanced", "paper"]).default("quick").describe("Profile used for one-shot defaults."),
  provider: providerNameSchema,
  base_url: z.string().optional().describe("OpenAI-compatible base URL, ending at /v1."),
  api_key_env: z.string().optional().describe("Environment variable that contains the API key."),
  supports_json_mode: z.boolean().optional().describe("Whether the base OpenAI-compatible provider supports response_format JSON mode."),
  generator_model: z.string().optional().describe("Model used for initial candidate generation."),
  mutator_model: z.string().optional().describe("Model used for critique-guided mutation."),
  judge_model: z.string().optional().describe("Model used for pairwise judging."),
  finalizer_model: z.string().optional().describe("Optional model used to polish the winning candidate."),
  request_timeout_ms: z.number().int().min(1).optional().describe("Logical provider-call deadline in milliseconds."),
  provider_max_concurrency: z.number().int().min(1).max(1_024).optional().describe("Process-shared maximum concurrent calls to this provider route."),
  model_output_tokens: modelOutputTokensArgsSchema.optional().describe("Per-role model output token caps for one-shot operations."),
  sampling_model_hints: z.array(z.string()).optional().describe("Optional MCP Sampling model hints."),
  sampling_cost_priority: z.number().min(0).max(1).optional().describe("MCP Sampling model preference for lower cost, from 0 to 1."),
  sampling_speed_priority: z.number().min(0).max(1).optional().describe("MCP Sampling model preference for speed, from 0 to 1."),
  sampling_intelligence_priority: z.number().min(0).max(1).optional().describe("MCP Sampling model preference for intelligence, from 0 to 1.")
});

export const rankArgsSchema = providerArgsSchema.extend({
  task: z.string().min(1).describe("Task text the candidates answer."),
  rubric: z.string().optional().describe("Optional judging rubric text."),
  candidates: z.array(z.union([z.string(), z.object({ id: z.string().optional(), content: z.string() })])).min(2).describe("Candidate texts or {id, content} objects."),
  judge_temperature: z.number().min(0).optional().describe("Temperature for pairwise judging."),
  lambda: z.number().min(0).optional().describe("Bradley-Terry L2 regularization."),
  rank: rankControlArgsSchema.optional().describe("Pair scheduling mode, degree, seed, and logical-call limit."),
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
  run_dir: z.string(),
  continue: z.boolean().optional()
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
  result_resource: z.string(),
  artifact_resources: z.record(z.string(), z.string())
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
  return planBudget(
    {
      ...base,
      n: args.n ?? config.algorithm?.n ?? base.n,
      k: args.k ?? config.algorithm?.k ?? base.k,
      t: args.t ?? config.algorithm?.t ?? base.t,
      m: args.m ?? config.algorithm?.m ?? base.m,
      lambda: config.algorithm?.lambda ?? base.lambda,
      sampleTemperature: config.algorithm?.sample_temperature ?? base.sampleTemperature,
      mutateTemperature: config.algorithm?.mutate_temperature ?? base.mutateTemperature,
      judgeTemperature: config.algorithm?.judge_temperature ?? base.judgeTemperature
    },
    {
      invalidJsonRetries: config.retry?.invalidJsonRetries ?? 1,
      includeFinalizer: Boolean(config.models?.finalizer || config.providers?.finalizer?.model)
    }
  ) as unknown as Record<string, unknown>;
}

export interface McpSamplingContext {
  getClientCapabilities(): ClientCapabilities | undefined;
  createMessage: SamplingTransport;
  transport?: "stdio" | "http";
  backgroundJobManager?: BackgroundJobManager;
}

interface BackgroundJobReservation {
  readonly id: symbol;
}

export interface BackgroundJobManagerStats {
  active: number;
  queued: number;
  reserved: number;
  maxActive: number;
  maxQueued: number;
}

/** Process-local FIFO admission control for MCP background jobs. */
export class BackgroundJobManager {
  private active = 0;
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly reservations = new Set<symbol>();

  constructor(
    private readonly maxActive = 2,
    private readonly maxQueued = 32
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("maxActive must be a positive integer.");
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error("maxQueued must be a non-negative integer.");
  }

  reserve(): BackgroundJobReservation | undefined {
    if (this.active + this.queue.length + this.reservations.size >= this.maxActive + this.maxQueued) return undefined;
    const id = Symbol("background-job-reservation");
    this.reservations.add(id);
    return { id };
  }

  release(reservation: BackgroundJobReservation): void {
    this.reservations.delete(reservation.id);
  }

  schedule(reservation: BackgroundJobReservation, task: () => Promise<void>): void {
    if (!this.reservations.delete(reservation.id)) throw new Error("Background job reservation is no longer valid.");
    if (this.active < this.maxActive) {
      this.start(task);
      return;
    }
    this.queue.push(task);
  }

  stats(): BackgroundJobManagerStats {
    return {
      active: this.active,
      queued: this.queue.length,
      reserved: this.reservations.size,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued
    };
  }

  private start(task: () => Promise<void>): void {
    this.active += 1;
    void Promise.resolve()
      .then(task)
      .catch((error) => {
        process.stderr.write(`deepthonk: background job escaped its safety wrapper: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
        this.active -= 1;
        const next = this.queue.shift();
        if (next) this.start(next);
      });
  }
}

const backgroundJobs = new BackgroundJobManager();

export async function deepthonkStart(argsInput: unknown, context?: McpSamplingContext): Promise<Record<string, unknown>> {
  const jobManager = context?.backgroundJobManager ?? backgroundJobs;
  const reservation = jobManager.reserve();
  if (!reservation) {
    const limits = jobManager.stats();
    throw new ConfigError(`The MCP background job queue is full (${limits.maxActive} active, ${limits.maxQueued} queued).`, {
      code: "mcp.job_queue_full",
      retryable: true,
      fix: "Retry after a running background job completes, or use blocking deepthonk.run."
    });
  }
  let scheduled = false;
  try {
    const { runConfig, providerConfig } = await resolveMcpRun(argsInput, context);
    if (context?.transport === "http" && providerConfigUsesSampling(providerConfig)) {
      throw new ConfigError("MCP Sampling is not available for HTTP background jobs.", {
        code: "mcp.http_background_sampling_unsupported",
        retryable: false,
        fix: "Use blocking deepthonk.run over the same HTTP session, use a direct provider, or use stdio for deepthonk.start with Sampling."
      });
    }
    const jobId = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    const claimed = await claimRunLockOwnership(runConfig.runDir, jobId);
    if (!claimed) {
      throw new ConfigError(`Run directory is already claimed: ${runConfig.runDir}`, {
        code: "run.directory_locked",
        retryable: false,
        fix: "Use a fresh run_dir or inspect the existing run status. DeepThonk does not treat an occupied directory as an idempotent retry."
      });
    }
    try {
      await new TraceStore(runConfig.runDir).writeStatus({
        job_id: jobId,
        run_dir: runConfig.runDir,
        state: "pending",
        phase: "queued",
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        started_at: now,
        worker_pid: process.pid,
        updated_at: now
      });
    } catch (error) {
      await safeReleaseRunLock(runConfig.runDir, claimed.claimId);
      throw error;
    }
    jobManager.schedule(reservation, () => runBackgroundJob(runConfig, providerConfig, jobId, now, claimed));
    scheduled = true;
    const resources = jobArtifactResources(jobId, runConfig.runDir);
    return {
      job_id: jobId,
      run_dir: runConfig.runDir,
      state: "pending",
      status_resource: resources.status,
      result_resource: resources.result,
      artifact_resources: resources
    };
  } finally {
    if (!scheduled) jobManager.release(reservation);
  }
}

function providerConfigUsesSampling(config: ProviderConfig): boolean {
  return config.provider === "sampling" || Object.values(config.roleProviders ?? {}).some((role) => role?.provider === "sampling");
}

async function runBackgroundJob(
  runConfig: Parameters<typeof runDeepThonk>[0],
  providerConfig: ProviderConfig,
  jobId: string,
  startedAt: string,
  lockClaim: RunLockClaim
): Promise<void> {
  try {
    const driver = createDriver(providerConfig);
    const result = await runDeepThonk(runConfig, driver, {
      jobId,
      lockClaim,
      shouldCancel: () => isRunCancelRequested(runConfig.runDir)
    });
    await safeRecordRunResource(result.runId, result.runDir);
  } catch (error) {
    await safePersistFailureStatus(runConfig.runDir, jobId, startedAt, error);
  } finally {
    await safeReleaseRunLock(runConfig.runDir, lockClaim.claimId);
  }
}

async function safeRecordRunResource(runId: string, runDir: string): Promise<void> {
  try {
    await recordRunResource(runId, runDir);
  } catch (error) {
    process.stderr.write(`deepthonk: failed to record run resource: ${(error as Error).message}\n`);
  }
}

async function safePersistFailureStatus(runDir: string, jobId: string, startedAt: string, error: unknown): Promise<void> {
  try {
    const existing = await readRunStatus(runDir);
    if (existing && ["completed", "failed", "cancelled", "budget_exceeded"].includes(existing.state)) return;
    const serialized = serializeToolError(error, runDir);
    await new TraceStore(runDir).writeStatus({
      job_id: jobId,
      run_dir: runDir,
      state: "failed",
      phase: "failed",
      usage: existing?.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      started_at: existing?.started_at ?? startedAt,
      worker_pid: process.pid,
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
}

async function safeReleaseRunLock(runDir: string, claimId: string): Promise<void> {
  try {
    await releaseRunLock(runDir, claimId);
  } catch (error) {
    process.stderr.write(`deepthonk: failed to release run lock: ${(error as Error).message}\n`);
  }
}

export async function deepthonkStatus(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = jobArgsSchema.parse(argsInput);
  const runDir = await resolveJobRunDir(args);
  const status = await readRunStatus(runDir);
  if (args.job_id && status?.job_id && args.job_id !== status.job_id) throw jobMismatch(args.job_id, status.job_id);
  if (status) return { ...status };
  return { ...(await detectResumeState(runDir)), run_dir: runDir };
}

export async function deepthonkLockInspect(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = lockInspectArgsSchema.parse(argsInput);
  return { run_dir: args.run_dir, ...(await inspectRunLock(args.run_dir)) };
}

export async function deepthonkLockReclaim(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = lockReclaimArgsSchema.parse(argsInput);
  return {
    run_dir: args.run_dir,
    fingerprint: args.fingerprint,
    reclaimed: await reclaimRunLock(args.run_dir, args.fingerprint)
  };
}

export async function deepthonkRepairBudget(argsInput: unknown): Promise<Record<string, unknown>> {
  const args = repairBudgetArgsSchema.parse(argsInput);
  return { run_dir: args.run_dir, repaired: await repairLegacyBudgetConfig(args.run_dir, args.replacements) };
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
  const fullResult = {
    complete: true,
    run_id: runId,
    run_dir: runDir,
    summary,
    summary_resource: runId ? `deepthonk://runs/${runId}/summary` : undefined,
    trace_resource: runId ? `deepthonk://runs/${runId}/trace` : undefined
  };
  if (Buffer.byteLength(JSON.stringify(fullResult), "utf8") <= MAX_RESOURCE_BYTES) return fullResult;
  return {
    complete: true,
    run_id: runId,
    run_dir: runDir,
    summary_omitted: true,
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

export async function deepthonkRun(argsInput: unknown, context?: McpSamplingContext): Promise<Record<string, unknown>> {
  const { runConfig, providerConfig } = await resolveMcpRun(argsInput, context);
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

async function resolveMcpRun(argsInput: unknown, context?: McpSamplingContext): Promise<{ runConfig: Parameters<typeof runDeepThonk>[0]; providerConfig: ProviderConfig }> {
  const raw = objectInput(argsInput);
  const args = runArgsSchema.parse(argsInput);
  const config = await readMcpConfig(args.config_path, args.profile_name);
  const profileName = (raw.profile ?? config.profile ?? args.profile) as BuiltInProfileName;
  const baseProfile = getProfile(profileName);
  const profile = mergeProfileOverrides(baseProfile, config.algorithm, args);
  const providerConfig = resolveMcpProviderConfig(args, raw, config, context?.createMessage);
  assertSupportedSamplingRoutes(providerConfig);
  assertSamplingCapability(providerConfig, context);
  const models = providerConfig.models;
  const runDir = args.run_dir ?? (args.run_id ? `runs/${args.run_id}` : `runs/mcp-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  const promptOverrides = mergePromptOverrides(config.prompts, args.prompts);
  const concurrency = capSamplingConcurrency(providerConfig.provider, profile, {
    generate: args.concurrency?.generate ?? config.concurrency?.generate ?? profile.n,
    judge: args.concurrency?.judge ?? config.concurrency?.judge ?? Math.max(1, (profile.n * Math.max(profile.k, profile.m)) / 2),
    mutate: args.concurrency?.mutate ?? config.concurrency?.mutate ?? profile.n - Math.floor(profile.n / 4)
  });
  return {
    runConfig: {
      runId: args.run_id ?? config.runId,
      task: args.task,
      rubric: args.rubric,
      promptStyle: args.prompt_style ?? config.prompt_style ?? (profileName === "paper" ? "paper-programming" : "general"),
      promptOverrides,
      profile,
      runDir,
      seed: args.seed,
      provider: providerConfig.provider,
      providerReplay: providerReplayFromConfig(providerConfig),
      generatorModel: models.generator,
      mutatorModel: models.mutator,
      judgeModel: models.judge,
      finalizerModel: models.finalizer,
      modelOutputTokens: mergeModelOutputTokens(config.modelOutputTokens, args.model_output_tokens),
      critiqueLimits: mergeCritiqueLimits(config.critiqueLimits, args.critique_limits),
      rank: mergeRankControls(config.rank, args.rank),
      providerMaxConcurrency: args.provider_max_concurrency ?? config.providerMaxConcurrency,
      concurrency,
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

export async function deepthonkRank(argsInput: unknown, context?: McpSamplingContext): Promise<Record<string, unknown>> {
  const args = rankArgsSchema.parse(argsInput);
  const raw = objectInput(argsInput);
  const oneShot = await resolveMcpOneShot(args, raw, context?.createMessage);
  const providerConfig = oneShot.providerConfig;
  assertSupportedSamplingRoutes(providerConfig);
  assertSamplingCapability(providerConfig, context);
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
    temperature: args.judge_temperature ?? oneShot.profile.judgeTemperature,
    lambda: args.lambda ?? oneShot.profile.lambda,
    seed: oneShot.rank?.seed,
    mode: oneShot.rank?.mode,
    k: oneShot.rank?.k,
    maxCalls: oneShot.rank?.maxCalls,
    maxOutputTokens: oneShot.modelOutputTokens?.judge,
    concurrency: capOneShotConcurrency(providerConfig.provider, args.concurrency ?? oneShot.concurrency.judge),
    promptStyle: oneShot.promptStyle,
    promptOverrides: oneShot.promptOverrides?.compare ? { compare: oneShot.promptOverrides.compare } : undefined
  });
  return { scores: result.scores, comparisons: result.comparisons };
}

export async function deepthonkMutate(argsInput: unknown, context?: McpSamplingContext): Promise<Record<string, unknown>> {
  const args = mutateArgsSchema.parse(argsInput);
  const raw = objectInput(argsInput);
  const oneShot = await resolveMcpOneShot(args, raw, context?.createMessage);
  const providerConfig = oneShot.providerConfig;
  assertSupportedSamplingRoutes(providerConfig);
  assertSamplingCapability(providerConfig, context);
  const models = providerConfig.models;
  return {
    ...(await mutateCandidate({
      task: args.task,
      rubric: args.rubric,
      candidate: { id: "mcp-candidate", content: args.candidate },
      driver: createDriver(providerConfig),
      mutatorModel: models.mutator,
      temperature: args.mutate_temperature ?? oneShot.profile.mutateTemperature,
      maxOutputTokens: oneShot.modelOutputTokens?.mutation,
      critique: args.critique,
      promptStyle: oneShot.promptStyle,
      promptOverrides: oneShot.promptOverrides?.mutate ? { mutate: oneShot.promptOverrides.mutate } : undefined
    }))
  };
}

export async function deepthonkResume(argsInput: unknown, context?: McpSamplingContext): Promise<Record<string, unknown>> {
  const args = resumeArgsSchema.parse(argsInput);
  if (args.continue === true) {
    const raw = JSON.parse(await readFile(join(args.run_dir, "config.json"), "utf8")) as unknown;
    const config = runConfigSchema.parse(raw);
    const replayedProvider = config.providerReplay
      ? providerConfigFromReplay(parseProviderReplay(config.providerReplay)!, config.retry, {
          providerMaxConcurrency: config.providerMaxConcurrency,
          samplingTransport: config.providerReplay.provider === "sampling" ? context?.createMessage : undefined
        })
      : resolveProviderConfig({
          provider: config.provider,
          models: {
            generator: config.generatorModel,
            mutator: config.mutatorModel,
            judge: config.judgeModel,
            finalizer: config.finalizerModel
          },
          retry: config.retry,
          providerMaxConcurrency: config.providerMaxConcurrency,
          samplingTransport: config.provider === "sampling" ? context?.createMessage : undefined
        });
    const providerConfig = replayedProvider;
    assertSupportedSamplingRoutes(providerConfig);
    assertSamplingCapability(providerConfig, context);
    const result = await resumeDeepThonk(
      args.run_dir,
      createDriver(providerConfig),
      { provider: providerConfig.provider }
    );
    if ("winner" in result) {
      return {
        status: "completed",
        message: "Run resumed and completed.",
        run_id: result.runId,
        run_dir: result.runDir,
        winner_id: result.winner.id,
        final_answer: result.finalAnswer,
        calls: result.calls,
        safe_to_continue: false
      };
    }
    return { ...result };
  }
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

async function resolveMcpOneShot(
  args: z.infer<typeof providerArgsSchema> & {
    prompt_style?: Parameters<typeof runDeepThonk>[0]["promptStyle"];
    prompts?: McpPromptOverrides;
    rank?: z.infer<typeof rankControlArgsSchema>;
  },
  raw: Record<string, unknown>,
  samplingTransport?: SamplingTransport
): Promise<{
  providerConfig: ProviderConfig;
  profile: Parameters<typeof runDeepThonk>[0]["profile"];
  promptStyle: Parameters<typeof runDeepThonk>[0]["promptStyle"];
  promptOverrides?: Parameters<typeof runDeepThonk>[0]["promptOverrides"];
  concurrency: Parameters<typeof runDeepThonk>[0]["concurrency"];
  modelOutputTokens?: Parameters<typeof runDeepThonk>[0]["modelOutputTokens"];
  rank?: Parameters<typeof runDeepThonk>[0]["rank"];
}> {
  const config = await readMcpConfig(args.config_path, args.profile_name);
  const profileName = (raw.profile ?? config.profile ?? args.profile) as BuiltInProfileName;
  const profile = mergeProfileOverrides(getProfile(profileName), config.algorithm, args as z.infer<typeof runArgsSchema>);
  const providerConfig = resolveMcpProviderConfig(args, raw, config, samplingTransport);
  return {
    providerConfig,
    profile,
    promptStyle: args.prompt_style ?? config.prompt_style ?? (profileName === "paper" ? "paper-programming" : "general"),
    promptOverrides: mergePromptOverrides(config.prompts, args.prompts),
    modelOutputTokens: mergeModelOutputTokens(config.modelOutputTokens, args.model_output_tokens),
    rank: mergeRankControls(config.rank, args.rank),
    concurrency: capSamplingConcurrency(providerConfig.provider, profile, {
      generate: config.concurrency?.generate ?? profile.n,
      judge: config.concurrency?.judge ?? Math.max(1, (profile.n * Math.max(profile.k, profile.m)) / 2),
      mutate: config.concurrency?.mutate ?? profile.n - Math.floor(profile.n / 4)
    })
  };
}

function resolveMcpProviderConfig(
  args: ProviderResolutionArgs,
  raw: Record<string, unknown>,
  config: RawMcpConfig,
  samplingTransport?: SamplingTransport
): ProviderConfig {
  const provider = String(raw.provider ?? config.provider ?? args.provider);
  const providerChanged = raw.provider !== undefined && raw.provider !== config.provider;
  const baseUrlChanged = raw.base_url !== undefined && raw.base_url !== config.base_url;
  const isolateFileRoute = providerChanged || baseUrlChanged;
  const resolved = resolveProviderConfig({
    provider,
    baseUrl: args.base_url ?? (isolateFileRoute ? undefined : config.base_url),
    apiKeyEnv: args.api_key_env ?? (isolateFileRoute ? undefined : config.api_key_env),
    supportsJsonMode: args.supports_json_mode ?? (isolateFileRoute ? undefined : config.supports_json_mode),
    providerMaxConcurrency: args.provider_max_concurrency ?? config.providerMaxConcurrency,
    models: {
      generator: args.generator_model ?? (isolateFileRoute ? undefined : config.models?.generator),
      mutator: args.mutator_model ?? (isolateFileRoute ? undefined : config.models?.mutator),
      judge: args.judge_model ?? (isolateFileRoute ? undefined : config.models?.judge),
      finalizer: args.finalizer_model ?? (isolateFileRoute ? undefined : config.models?.finalizer)
    },
    roleProviders: isolateFileRoute ? undefined : normalizeRoleProviders(config.providers),
    inheritProviderDefaults: !baseUrlChanged,
    retry: { httpRetries: 2, requestTimeoutMs: args.request_timeout_ms ?? config.retry?.requestTimeoutMs }
  });
  if (provider !== "sampling") return resolved;
  return {
    ...resolved,
    samplingTransport,
    modelHints: args.sampling_model_hints,
    costPriority: args.sampling_cost_priority,
    speedPriority: args.sampling_speed_priority,
    intelligencePriority: args.sampling_intelligence_priority,
    includeRawOutputs: args.include_raw_model_outputs ?? config.output?.includeRawModelOutputs ?? false
  };
}

type ProviderResolutionArgs = z.infer<typeof providerArgsSchema> &
  Partial<
    Pick<
      z.infer<typeof runArgsSchema>,
      | "sampling_model_hints"
      | "sampling_cost_priority"
      | "sampling_speed_priority"
      | "sampling_intelligence_priority"
      | "include_raw_model_outputs"
    >
  >;

function assertSamplingCapability(providerConfig: ProviderConfig, context?: McpSamplingContext): void {
  if (!providerConfigUsesSampling(providerConfig)) return;
  const capabilities = context?.getClientCapabilities();
  if (!capabilities?.sampling) {
    throw new ConfigError("Connected MCP client does not advertise sampling capability. This client cannot serve as a sampling provider.", {
      code: "provider.sampling_capability_missing",
      retryable: false,
      fix: "Use an MCP client that supports sampling, or choose a direct provider such as deepseek, openrouter, or openai-compatible."
    });
  }
}

function assertSupportedSamplingRoutes(providerConfig: ProviderConfig): void {
  const roleRoutes = Object.entries(providerConfig.roleProviders ?? {});
  if (roleRoutes.length === 0) return;
  const samplingRoles = roleRoutes.filter(([, route]) => route?.provider === "sampling").map(([role]) => role);
  const directRoles = roleRoutes.filter(([, route]) => route?.provider !== "sampling").map(([role]) => role);
  if (samplingRoles.length === 0 && providerConfig.provider !== "sampling") return;
  const mixed = providerConfig.provider !== "sampling" || directRoles.length > 0;
  throw new ConfigError(
    mixed
      ? `Mixed MCP Sampling/direct role routes are unsupported (Sampling roles: ${samplingRoles.join(", ") || "base"}).`
      : "Role-specific MCP Sampling routes are unsupported; use Sampling as the single base provider.",
    {
      code: mixed ? "provider.mixed_sampling_routes_unsupported" : "provider.sampling_role_routes_unsupported",
      retryable: false,
      fix: "Use provider: sampling without providers role overrides, or use direct providers for every route."
    }
  );
}

function capSamplingConcurrency(
  provider: string,
  profile: Parameters<typeof runDeepThonk>[0]["profile"],
  concurrency: Parameters<typeof runDeepThonk>[0]["concurrency"]
): Parameters<typeof runDeepThonk>[0]["concurrency"] {
  if (provider !== "sampling") return concurrency;
  const cap = Math.min(profile.n, 4);
  return {
    generate: Math.min(concurrency.generate, cap),
    judge: Math.min(concurrency.judge, cap),
    mutate: Math.min(concurrency.mutate, cap)
  };
}

function capOneShotConcurrency(provider: string, concurrency: number): number {
  return provider === "sampling" ? Math.min(concurrency, 4) : concurrency;
}

export function toolResult(value: unknown): { structuredContent: Record<string, unknown>; content: Array<{ type: "text"; text: string }> } {
  const structuredContent = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { structuredContent, content: [{ type: "text", text: summarizeToolResult(structuredContent) }] };
}

export function toolError(error: unknown, runDir?: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const structuredContent = serializeToolError(error, runDir);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
}

type RawMcpConfig = ExternalConfigFile;

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
    return normalizeExternalConfig(await loadNamedProfile(profileName), `named profile '${profileName}'`);
  }
  if (!path) return {};
  return normalizeExternalConfig(YAML.parse(await readFile(resolveMcpPath(path), "utf8")), path);
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
  providers: RawMcpConfig["providers"]
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

function mergeModelOutputTokens(
  fileValue: Parameters<typeof runDeepThonk>[0]["modelOutputTokens"],
  inlineValue: z.infer<typeof modelOutputTokensArgsSchema> | undefined
): Parameters<typeof runDeepThonk>[0]["modelOutputTokens"] {
  if (!fileValue && !inlineValue) return undefined;
  return { ...(fileValue ?? {}), ...(inlineValue ?? {}) };
}

function mergeCritiqueLimits(
  fileValue: Parameters<typeof runDeepThonk>[0]["critiqueLimits"],
  inlineValue: { aggregate_chars?: number } | undefined
): Parameters<typeof runDeepThonk>[0]["critiqueLimits"] {
  if (!fileValue && !inlineValue) return undefined;
  return {
    ...(fileValue ?? {}),
    ...definedValues({ aggregateChars: inlineValue?.aggregate_chars })
  };
}

function mergeRankControls(
  fileValue: Parameters<typeof runDeepThonk>[0]["rank"],
  inlineValue: z.infer<typeof rankControlArgsSchema> | undefined
): Parameters<typeof runDeepThonk>[0]["rank"] {
  if (!inlineValue) return fileValue;
  return {
    ...(fileValue ?? {}),
    ...definedValues({
      mode: inlineValue.mode,
      k: inlineValue.k,
      seed: inlineValue.seed,
      maxCalls: inlineValue.max_calls
    })
  } as Parameters<typeof runDeepThonk>[0]["rank"];
}

function definedValues<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
  providers: z.record(z.string(), z.unknown()).optional(),
  algorithm: z.record(z.string(), z.unknown()).optional(),
  prompts: z.record(z.string(), z.object({ system: z.string().optional(), user: z.string().optional() })).optional(),
  budget: z.unknown().optional(),
  concurrency: z.unknown().optional(),
  retry: z.unknown().optional(),
  output: z.unknown().optional()
}).strict();

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
  rejectRawApiKeyFields(argsInput, "profile_save");
  rejectAllSecretShapedFields(argsInput, "profile_save");
  const args = parseProfileSaveArgs(argsInput);
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

type ProfileSaveArgs = z.infer<typeof profileSaveArgsSchema>;

function parseProfileSaveArgs(argsInput: unknown): ProfileSaveArgs {
  try {
    return profileSaveArgsSchema.parse(argsInput);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigError(formatZodIssues(error), {
        code: "mcp.invalid_arguments",
        retryable: false,
        fix: "Fix the tool arguments and retry."
      });
    }
    throw error;
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}

function redactedProfile(value: unknown): unknown {
  const serialized = JSON.stringify(value, (key, inner) => {
    if (SECRET_KEY_RE.test(key) && inner) return "[redacted]";
    return inner;
  });
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

async function saveMcpProfileBundle(name: string, bundle: NamedProfileBundle, force: boolean): Promise<string> {
  assertMcpProfileName(name);
  rejectRawApiKeyFields(bundle, name);
  rejectAllSecretShapedFields(bundle, name);
  validateNamedProfileBundle(bundle, name);
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
