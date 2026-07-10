import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fitBradleyTerry } from "./bradleyTerry.js";
import { BudgetTracker } from "./budgetTracker.js";
import type { CallReservation } from "./budgetTracker.js";
import { planBudget, validateProfile } from "./budget.js";
import { BudgetExceededError, CancelledError, ConfigError, DeepThonkError } from "./errors.js";
import { runArtifactFiles } from "./artifacts.js";
import { parseJsonObject } from "./json.js";
import {
  claimRunLockOwnership,
  emptyUsage,
  releaseRunLock,
  verifyRunLockClaim,
  type BudgetUsage,
  type CallRole,
  type RunLifecycleState,
  type RunStatus,
  type RunLockClaim,
  type UsageDelta,
  type UsageRecord
} from "./lifecycle.js";
import { makeKRegularPairs, type Pair } from "./pairScheduler.js";
import { runLimitedPhase } from "./phaseRunner.js";
import { comparePrompt, finalizePrompt, generatePrompt, mutatePrompt } from "./prompts.js";
import { createRng, type Rng } from "./rng.js";
import {
  assertNoPruneInProgress,
  assertNoLegacyRedactedBudget,
  buildPopulationMap,
  buildResumePlan,
  groupComparisons,
  persistPrunedTrace,
  pruneTraceToPlan,
  readResumeTrace,
  reconstructScores,
  replayBudgetUsage,
  resolveResumeRunId,
  resumeConfigError,
  toResumePlanStatus,
  type PhaseCursor
} from "./resume.js";
import {
  runConfigSchema,
  builtInProfiles,
  type BuiltInProfileName,
  type BtScore,
  type Candidate,
  type Comparison,
  type ModelDriver,
  type ModelTextResult,
  type PhaseName,
  phaseCompletedEventSchema,
  type RunConfig,
  type RunResult
} from "./schemas.js";
import { aggregateCritiques } from "./critique.js";
import { TraceStore } from "./traceStore.js";

const compareOutputSchema = z.object({
  winner: z.enum(["A", "B", "tie"]),
  confidence: z.number().min(0).max(1).optional(),
  critique_for_A: z.string().optional(),
  critique_for_B: z.string().optional(),
  feedback_a: z.string().optional(),
  feedback_b: z.string().optional(),
  selection_reason: z.string().default("")
});

export interface RunControl {
  jobId?: string;
  lockClaim?: RunLockClaim;
  shouldCancel?: () => boolean | Promise<boolean>;
}

export interface ResumeDeepThonkOptions {
  dryRun?: boolean;
  provider?: string;
}

type ProviderRole = "generator" | "mutator" | "judge" | "finalizer";

interface ProviderRouteFingerprint {
  provider?: string;
  baseUrl?: string;
  model?: string;
}

export interface ResumePlan {
  status: "completed" | "resumable";
  message: string;
  run_id?: string;
  run_dir: string;
  phase?: PhaseName | "summary";
  generation?: number | "final";
  safe_to_continue: boolean;
  summary?: Record<string, unknown>;
  plan?: {
    next_phase: PhaseName | "summary";
    generation?: number | "final";
    completed_phases: Array<{ phase: PhaseName; generation?: number }>;
  };
}

interface RunGuards {
  beforeCall(phase: string): Promise<CallReservation>;
  afterCall(phase: string): Promise<void>;
}

interface ResumeState {
  runId: string;
  startedAt: string;
  completed: Set<string>;
  populationByGeneration: Map<number, Candidate[]>;
  comparisonsByGeneration: Map<number | "final", Comparison[]>;
  scoresByGeneration: Map<number | "final", BtScore[]>;
  tracker: BudgetTracker;
  nextPhase: PhaseCursor;
}

export async function runDeepThonk(
  configInput: RunConfig,
  driver: ModelDriver,
  control: RunControl = {},
  resumeState?: ResumeState
): Promise<RunResult> {
  const config = runConfigSchema.parse(configInput);
  validateProfile(config.profile);
  enforceBudget(config);

  const runId =
    resumeState?.runId ??
    config.runId ??
    `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
  const trace = new TraceStore(config.runDir);
  const rng = createRng(config.seed);
  const tracker = resumeState?.tracker ?? new BudgetTracker(config);
  const startedAt = resumeState?.startedAt ?? new Date().toISOString();
  let ownsLock = false;
  let ownedLockClaimId: string | undefined;
  let verifiedPreclaim = false;
  if (!resumeState) {
    if (control.lockClaim) {
      verifiedPreclaim = await verifyRunLockClaim(config.runDir, control.lockClaim, control.jobId);
      if (!verifiedPreclaim) {
        throw new ConfigError("The supplied run lock claim does not own the current run.lock.", {
          code: "run.lock_not_owned",
          retryable: false,
          fix: "Claim the run directory with claimRunLockOwnership and pass that exact claim to the worker."
        });
      }
    } else {
      const claimed = await claimRunLockOwnership(config.runDir, control.jobId ?? runId);
      if (!claimed) {
        throw new ConfigError(`Run directory is already claimed: ${config.runDir}`, {
          code: "run.directory_locked",
          retryable: false,
          fix: "Wait for the active run to finish, or choose a fresh run directory."
        });
      }
      ownsLock = true;
      ownedLockClaimId = claimed.claimId;
    }
  }
  let stopped = false;
  let caughtError: unknown;
  const writeStatus = async (
    state: RunLifecycleState,
    phase: string,
    extra: Partial<Omit<RunStatus, "run_dir" | "state" | "phase" | "usage" | "updated_at">> = {}
  ): Promise<void> => {
    await trace.writeStatus({
      job_id: control.jobId,
      run_id: runId,
      run_dir: config.runDir,
      state,
      phase,
      usage: cloneUsage(tracker.usage),
      started_at: startedAt,
      worker_pid: process.pid,
      updated_at: new Date().toISOString(),
      ...extra
    });
  };
  const assertNotCancelled = async (phase: string): Promise<void> => {
    if (await control.shouldCancel?.()) {
      throw new CancelledError(`Run cancelled before ${phase}.`, {
        code: "run.cancelled",
        retryable: false,
        fix: "Resume the run with deepthonk resume --continue after the worker has stopped."
      });
    }
  };
  const assertBudget = async (phase: string): Promise<void> => {
    try {
      tracker.assertWithinBudget(phase);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        stopped = true;
        await bestEffortTraceWrite("budget exceeded event", () =>
          trace.event({ type: "budget.exceeded", phase, usage: cloneUsage(tracker.usage), error: serializeRunError(error) })
        );
      }
      throw error;
    }
  };
  const guards: RunGuards = {
    async beforeCall(phase: string): Promise<CallReservation> {
      if (stopped) throw new BudgetExceededError(`Run already stopped before ${phase}.`, { code: "budget.stopped" });
      await assertNotCancelled(phase);
      await assertBudget(phase);
      return tracker.reserveCall(phase);
    },
    async afterCall(phase: string): Promise<void> {
      await assertNotCancelled(phase);
      await assertBudget(phase);
    }
  };

  try {
    if (!resumeState) {
      await trace.init(
        { ...config, version: await currentPackageVersion() },
        runId,
        { allowOwnedLock: ownsLock || verifiedPreclaim, pendingJobId: verifiedPreclaim ? control.jobId : undefined }
      );
    } else {
      await trace.event({
        type: "run.resumed",
        run_id: runId,
        resumed_at: new Date().toISOString(),
        next_phase: resumeState.nextPhase.phase,
        generation: resumeState.nextPhase.generation
      });
    }
    await writeStatus("running", resumeState ? "resume_replay" : "initialized");
    let population: Candidate[];
    if (isResumePhaseCompleted(resumeState, "initial_generation")) {
      population = resumePopulation(resumeState, 0);
    } else {
      await assertNotCancelled("initial population");
      population = await generateInitialPopulation(config, driver, trace, rng, runId, tracker, guards);
      await trace.writePopulation(0, population);
      await assertBudget("initial population");
      await markPhaseCompleted(trace, "initial_generation");
      await writeStatus("running", "population_completed", { generation: 0 });
    }

    for (let gen = 1; gen <= config.profile.t; gen += 1) {
      if (isResumePhaseCompleted(resumeState, "generation_mutation", gen)) {
        population = resumePopulation(resumeState, gen);
        continue;
      }

      let comparisons: Comparison[];
      let scores: BtScore[];
      if (isResumePhaseCompleted(resumeState, "generation_judging", gen)) {
        comparisons = resumeComparisons(resumeState, gen);
        scores = resumeScores(resumeState, gen, population, comparisons, config.profile.lambda);
      } else {
        await assertNotCancelled(`generation ${gen} comparisons`);
        await writeStatus("running", "generation_comparisons", { generation: gen });
        const judgingRng = phaseRng(config.seed, "generation_judging", gen);
        const pairs = makeKRegularPairs(
          population.map((candidate) => candidate.id),
          config.profile.k,
          judgingRng
        );
        comparisons = await judgePairs({
          config,
          driver,
          trace,
          rng: judgingRng,
          runId,
          generation: gen,
          pairs,
          population,
          tracker,
          guards
        });

        scores = fitBradleyTerry(population, comparisons, config.profile.lambda, gen);
        await trace.writeScores(gen, scores);
        await assertBudget(`generation ${gen} comparisons`);
        await markPhaseCompleted(trace, "generation_judging", gen);
      }

      const ranked = rankPopulation(population, scores);
      const elites = topQuartile(ranked);
      const discarded = bottomQuartile(ranked);
      const survivors = ranked.filter((candidate) => !discarded.has(candidate.id));
      const mutationParents = survivors.slice(0, config.profile.n - elites.length);
      const critiquesByCandidate = aggregateCritiques(population, comparisons);

      await assertNotCancelled(`generation ${gen} mutation`);
      await writeStatus("running", "generation_mutation", { generation: gen });
      await traceDiscardedCandidates(trace, ranked, new Set([...elites, ...mutationParents].map((candidate) => candidate.id)), discarded, gen);
      const mutants = await mutateSurvivors({
        config,
        driver,
        trace,
        generation: gen,
        survivors: mutationParents,
        critiquesByCandidate,
        tracker,
        guards
      });

      const eliteCopies = copyElites(elites, gen);
      for (const elite of eliteCopies) {
        await trace.writeCandidate(elite);
        await trace.event({ type: "candidate.elite_copied", candidate_id: elite.id, parent_id: elite.parentId, generation: gen });
      }
      population = keepPopulationSize([...eliteCopies, ...mutants], config.profile.n);
      await trace.writePopulation(gen, population);
      await assertBudget(`generation ${gen} mutation`);
      await markPhaseCompleted(trace, "generation_mutation", gen);
      await writeStatus("running", "generation_completed", { generation: gen });
    }

    let finalComparisons: Comparison[];
    let finalScores: BtScore[];
    if (isResumePhaseCompleted(resumeState, "final_judging")) {
      finalComparisons = resumeComparisons(resumeState, "final");
      finalScores = resumeScores(resumeState, "final", population, finalComparisons, config.profile.lambda);
    } else {
      await assertNotCancelled("final ranking");
      await writeStatus("running", "final_ranking", { generation: "final" });
      const finalRng = phaseRng(config.seed, "final_judging");
      const finalPairs = makeKRegularPairs(
        population.map((candidate) => candidate.id),
        config.profile.m,
        finalRng
      );
      finalComparisons = await judgePairs({
        config,
        driver,
        trace,
        rng: finalRng,
        runId,
        generation: "final",
        pairs: finalPairs,
        population,
        tracker,
        guards
      });
      finalScores = fitBradleyTerry(population, finalComparisons, config.profile.lambda, "final");
      await trace.writeScores("final", finalScores);
      await assertBudget("final ranking");
      await markPhaseCompleted(trace, "final_judging");
    }
    const winner = rankPopulation(population, finalScores)[0];
    if (!winner) throw new ConfigError("Run produced no winner.");

    await assertNotCancelled("finalization");
    await writeStatus("running", "finalizing", { generation: "final" });
    const finalAnswer = await maybeFinalize(winner, config, driver, trace, tracker, guards);
    await assertBudget("finalization");
    const completedAt = new Date().toISOString();
    const summary = {
      run_id: runId,
      winner_id: winner.id,
      profile: summaryProfile(config.profile),
      profile_name: summaryProfileName(config.profile),
      prompt_style: config.promptStyle,
      models: summaryModels(config),
      calls: tracker.usage.calls,
      usage: cloneUsage(tracker.usage),
      ranked_winner_answer_path: "artifacts/winner.txt",
      final_answer_path: "artifacts/final.txt",
      final_answer_is_postprocessed: finalAnswer !== winner.content,
      final_scores: finalScores,
      completed_at: completedAt
    };
    await trace.writeSummary(summary, finalAnswer, winner.content);
    await markPhaseCompleted(trace, "finalizing");
    await trace.event({ type: "run.completed", winner_id: winner.id, completed_at: completedAt });
    if (resumeState) await trace.event({ type: "run.resumed_completed", winner_id: winner.id, completed_at: completedAt });
    await writeStatus("completed", "summary", { generation: "final", completed_at: completedAt });

    return {
      runId,
      runDir: config.runDir,
      winner,
      finalAnswer,
      finalScores,
      calls: tracker.usage.calls
    };
  } catch (error) {
    caughtError = error;
    const serialized = serializeRunError(error);
    const state: RunLifecycleState =
      error instanceof CancelledError ? "cancelled" : error instanceof BudgetExceededError ? "budget_exceeded" : "failed";
    await bestEffortTraceWrite("run failure event", () =>
      trace.event({ type: `run.${state}`, run_id: runId, error: serialized, updated_at: new Date().toISOString() })
    );
    await bestEffortTraceWrite("run failure status", () => writeStatus(state, state, { error: serialized }));
    throw error;
  } finally {
    if (ownsLock) {
      try {
        await releaseRunLock(config.runDir, ownedLockClaimId);
      } catch (error) {
        if (caughtError !== undefined) {
          process.stderr.write(`deepthonk: failed to release run lock: ${(error as Error).message}\n`);
        } else {
          throw error;
        }
      }
    }
  }
}

export async function resumeDeepThonk(
  runDir: string,
  driver: ModelDriver,
  options: ResumeDeepThonkOptions = {}
): Promise<RunResult | ResumePlan> {
  const existingSummary = await readOptionalJson<Record<string, unknown>>(runDir, runArtifactFiles.summary);
  if (existingSummary) {
    resumeConfigError(
      "Run already has summary.json; nothing to resume.",
      "resume.already_complete",
      "Use deepthonk inspect/result to read the completed run."
    );
  }

  const rawConfig = await readRequiredConfig(runDir);
  assertNoLegacyRedactedBudget(rawConfig);
  const currentVersion = await currentPackageVersion();
  if (!sameMajorMinor(typeof rawConfig.version === "string" ? rawConfig.version : undefined, currentVersion)) {
    resumeConfigError(
      `Cannot resume run from version ${String(rawConfig.version ?? "missing")}; current package version is ${currentVersion}. Resume requires matching major.minor.`,
      "resume.version_mismatch",
      "Start a fresh run with the current DeepThonk version, or resume with a package version whose major.minor matches the trace."
    );
  }
  assertStoredOutputConfigComplete(rawConfig);
  const parsedConfig = runConfigSchema.parse(rawConfig);
  const config: RunConfig = { ...parsedConfig, runDir };
  validateProfile(config.profile);
  enforceBudget(config);

  assertResumeProviderMatches(rawConfig, config, driver, options);
  assertNoPruneInProgress(runDir);
  const lockRunId = resolveResumeRunId(config, undefined, []);
  const claimed = await claimRunLockOwnership(runDir, lockRunId);
  if (!claimed) {
    throw new ConfigError(`Run directory is already claimed: ${runDir}`, {
      code: "run.directory_locked",
      retryable: false,
      fix: "Wait for the active run to finish, or inspect the existing run.lock file."
    });
  }

  try {
    const status = await readOptionalJson<RunStatus>(runDir, runArtifactFiles.status);
    if ((status?.state === "running" || status?.state === "pending") && isLiveWorker(status.worker_pid)) {
      resumeConfigError(
        `Run is still in flight at phase ${status.phase}.`,
        "resume.in_flight",
        "Wait for the worker to finish, or cancel/stop it before resuming."
      );
    }

    const trace = await readResumeTrace(runDir);
    const runId = resolveResumeRunId(config, status, trace.events);
    const plan = buildResumePlan(config, trace.events);
    if (plan.nextPhase.phase === "summary") {
      resumeConfigError(
        "Trace says finalizing completed, but summary.json is missing.",
        "resume.inconsistent_trace",
        "Inspect the run directory and restore summary.json, or start a fresh run."
      );
    }

    const planStatus = toResumePlanStatus(runDir, runId, plan);
    const pruned = pruneTraceToPlan(trace, plan);
    assertResumeRunIdsAgree(runId, config, status, pruned);
    const populationByGeneration = buildPopulationMap(config, pruned.populations, pruned.candidates, plan);
    const comparisonsByGeneration = groupComparisons(pruned.comparisons);
    const scoresByGeneration = reconstructScores(config, populationByGeneration, comparisonsByGeneration, pruned.scores, plan, runId);
    if (options.dryRun) return planStatus;

    const tracker = replayBudgetUsage(config, pruned.usage);
    const startedAt = status?.started_at ?? new Date().toISOString();
    await new TraceStore(runDir).writeStatus({
      run_id: runId,
      run_dir: runDir,
      state: "running",
      phase: "resume_planning",
      usage: cloneUsage(tracker.usage),
      started_at: startedAt,
      worker_pid: process.pid,
      updated_at: new Date().toISOString()
    });
    await persistPrunedTrace(runDir, pruned);

    return await runDeepThonk(config, driver, {}, {
      runId,
      startedAt,
      completed: plan.completed,
      populationByGeneration,
      comparisonsByGeneration,
      scoresByGeneration,
      tracker,
      nextPhase: plan.nextPhase
    });
  } finally {
    await releaseRunLock(runDir, claimed?.claimId);
  }
}

function assertResumeRunIdsAgree(
  resolvedRunId: string,
  config: RunConfig,
  status: RunStatus | undefined,
  trace: Awaited<ReturnType<typeof readResumeTrace>>
): void {
  const observed = new Set<string>();
  if (config.runId) observed.add(config.runId);
  if (status?.run_id) observed.add(status.run_id);
  for (const event of trace.events) {
    if (typeof event.run_id === "string") observed.add(event.run_id);
  }
  for (const comparison of trace.comparisons) {
    if (comparison.runId) observed.add(comparison.runId);
  }
  observed.add(resolvedRunId);
  if (observed.size > 1) {
    resumeConfigError(
      `Resume artifacts disagree on run ID: ${[...observed].sort().join(", ")}.`,
      "resume.run_id_mismatch",
      "Restore artifacts from one run; do not combine trace files from different run directories."
    );
  }
}

async function markPhaseCompleted(trace: TraceStore, phase: PhaseName, generation?: number): Promise<void> {
  const event = phaseCompletedEventSchema.parse({
    type: "phase.completed",
    phase,
    generation,
    at: new Date().toISOString()
  });
  await trace.event(event);
}

function isResumePhaseCompleted(resumeState: ResumeState | undefined, phase: PhaseName, generation?: number): boolean {
  return Boolean(resumeState?.completed.has(resumePhaseKey(phase, generation)));
}

function resumePopulation(resumeState: ResumeState | undefined, generation: number): Candidate[] {
  const population = resumeState?.populationByGeneration.get(generation);
  if (!population) {
    throw new ConfigError(`Resume state is missing population generation ${generation}.`, {
      code: "resume.population_missing",
      retryable: false,
      fix: "Inspect the run directory for missing population snapshots."
    });
  }
  return population;
}

function resumeComparisons(resumeState: ResumeState | undefined, generation: number | "final"): Comparison[] {
  const comparisons = resumeState?.comparisonsByGeneration.get(generation);
  if (!comparisons) {
    throw new ConfigError(`Resume state is missing comparisons for generation ${generation}.`, {
      code: "resume.comparisons_missing",
      retryable: false,
      fix: "Inspect the run directory for missing comparison trace rows."
    });
  }
  return comparisons;
}

function resumeScores(
  resumeState: ResumeState | undefined,
  generation: number | "final",
  population: Candidate[],
  comparisons: Comparison[],
  lambda: number
): BtScore[] {
  return resumeState?.scoresByGeneration.get(generation) ?? fitBradleyTerry(population, comparisons, lambda, generation);
}

function phaseRng(seed: number, phase: PhaseName, generation?: number | "final"): Rng {
  return createRng(hashSeed(`${seed}:${phase}:${generation ?? ""}`));
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resumePhaseKey(phase: PhaseName, generation?: number): string {
  if ((phase === "generation_judging" || phase === "generation_mutation") && generation !== undefined) return `${phase}:${generation}`;
  return phase;
}

function providerLabel(driver: ModelDriver): string | undefined {
  const value = driver as { provider?: unknown; providerName?: unknown; config?: { provider?: unknown }; baseDriver?: ModelDriver };
  if (typeof value.provider === "string") return value.provider;
  if (typeof value.providerName === "string") return value.providerName;
  if (typeof value.config?.provider === "string") return value.config.provider;
  if (value.baseDriver) return providerLabel(value.baseDriver);
  const constructorName = driver.constructor?.name;
  if (constructorName === "FakeDriver") return "fake";
  if (constructorName === "SamplingDriver") return "sampling";
  if (constructorName === "OpenAiCompatibleDriver") return "openai-compatible";
  return undefined;
}

function assertStoredOutputConfigComplete(rawConfig: Record<string, unknown>): void {
  const output = rawConfig.output;
  if (!isRecord(output) || typeof output.includeRawModelOutputs !== "boolean" || typeof output.includePrompts !== "boolean") {
    resumeConfigError(
      "Stored config.json is missing the complete output block required for deterministic resume.",
      "resume.config_incomplete",
      "Restore output.includeRawModelOutputs and output.includePrompts, or start a fresh run."
    );
  }
}

function assertResumeProviderMatches(
  rawConfig: Record<string, unknown>,
  config: RunConfig,
  driver: ModelDriver,
  options: ResumeDeepThonkOptions
): void {
  assertProviderReplayInternalConsistency(config);
  const runtimeProvider = options.provider ?? providerLabel(driver) ?? config.provider;
  if (runtimeProvider !== config.provider) {
    providerMismatch(`Cannot resume provider ${config.provider} with runtime provider ${runtimeProvider}.`);
  }
  const expectedFingerprint = config.providerReplay?.routeFingerprint;
  if (expectedFingerprint !== undefined && providerRouteFingerprint(driver) !== expectedFingerprint) {
    providerMismatch("Cannot resume because the provider route fingerprint changed.");
  }
  if (
    config.providerReplay?.baseUrl !== undefined &&
    normalizeBaseUrl(providerBaseUrl(driver)) !== normalizeBaseUrl(config.providerReplay.baseUrl)
  ) {
    providerMismatch(
      `Cannot resume base URL ${config.providerReplay.baseUrl} with runtime base URL ${providerBaseUrl(driver) ?? "missing"}.`
    );
  }

  const expectedRoutes = expectedProviderRoutes(rawConfig, config);
  const actualRoutes = runtimeProviderRoutes(driver);
  for (const role of providerRoles) {
    const expected = expectedRoutes[role];
    if (!expected) continue;
    const actual = actualRoutes[role];
    if (!actual) {
      providerMismatch(`Cannot resume ${role} route ${routeLabel(expected)} without a matching runtime route.`);
    }
    if (expected.provider !== undefined && actual.provider !== expected.provider) {
      providerMismatch(`Cannot resume ${role} route provider ${expected.provider} with runtime provider ${actual.provider ?? "missing"}.`);
    }
    if (expected.baseUrl !== undefined && normalizeBaseUrl(actual.baseUrl) !== normalizeBaseUrl(expected.baseUrl)) {
      providerMismatch(`Cannot resume ${role} route baseUrl ${expected.baseUrl} with runtime baseUrl ${actual.baseUrl ?? "missing"}.`);
    }
    if (expected.model !== undefined && actual.model !== expected.model) {
      providerMismatch(`Cannot resume ${role} route model ${expected.model} with runtime model ${actual.model ?? "missing"}.`);
    }
  }
}

function assertProviderReplayInternalConsistency(config: RunConfig): void {
  const replay = config.providerReplay;
  if (!replay) return;
  const expectedModels = {
    generator: config.generatorModel,
    mutator: config.mutatorModel,
    judge: config.judgeModel,
    finalizer: config.finalizerModel
  };
  if (
    replay.provider !== config.provider ||
    replay.models.generator !== expectedModels.generator ||
    replay.models.mutator !== expectedModels.mutator ||
    replay.models.judge !== expectedModels.judge ||
    replay.models.finalizer !== expectedModels.finalizer
  ) {
    resumeConfigError(
      "Stored run provider/model fields disagree with providerReplay.",
      "resume.provider_replay_mismatch",
      "Restore config.json from the original run; do not edit provider or model fields independently."
    );
  }
  if (replay.routeFingerprint !== undefined && replay.routeFingerprint !== coreProviderReplayFingerprint(replay)) {
    resumeConfigError(
      "Stored providerReplay fingerprint does not match its route fields.",
      "resume.provider_replay_mismatch",
      "Restore the original providerReplay block instead of editing route fields."
    );
  }
}

function coreProviderReplayFingerprint(replay: NonNullable<RunConfig["providerReplay"]>): string {
  const roles = Object.fromEntries(
    providerRoles.flatMap((role) => {
      const route = replay.roleProviders?.[role];
      return route
        ? [[role, routeFingerprintValue(route.provider, route.baseUrl, route.apiKeyEnv, route.model, route.supportsJsonMode)] as const]
        : [];
    })
  );
  const value = {
    base: routeFingerprintValue(replay.provider, replay.baseUrl, replay.apiKeyEnv, replay.models, replay.supportsJsonMode),
    roles,
    samplingPreferences: replay.samplingPreferences ?? null
  };
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function routeFingerprintValue(
  provider: string,
  baseUrl: string | undefined,
  apiKeyEnv: string | undefined,
  model: string | NonNullable<RunConfig["providerReplay"]>["models"],
  supportsJsonMode: boolean | undefined
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      provider,
      baseUrl: normalizeFingerprintUrl(baseUrl),
      apiKeyEnv,
      model,
      supportsJsonMode
    }).filter(([, value]) => value !== undefined)
  );
}

function normalizeFingerprintUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const providerRoles = ["generator", "mutator", "judge", "finalizer"] as const satisfies readonly ProviderRole[];

function expectedProviderRoutes(rawConfig: Record<string, unknown>, config: RunConfig): Partial<Record<ProviderRole, ProviderRouteFingerprint>> {
  const replayRoutes = config.providerReplay?.roleProviders;
  if (replayRoutes) {
    const routes: Partial<Record<ProviderRole, ProviderRouteFingerprint>> = {};
    for (const role of providerRoles) {
      const route = replayRoutes[role];
      if (!route) continue;
      routes[role] = {
        provider: route.provider,
        baseUrl: route.baseUrl,
        model: route.model
      };
    }
    return routes;
  }
  const providers = rawConfig.providers;
  if (!isRecord(providers)) return {};
  const routes: Partial<Record<ProviderRole, ProviderRouteFingerprint>> = {};
  for (const role of providerRoles) {
    const rawRoute = providers[role];
    if (!isRecord(rawRoute)) continue;
    routes[role] = {
      provider: stringValue(rawRoute.provider) ?? config.provider,
      baseUrl: stringValue(rawRoute.baseUrl) ?? stringValue(rawRoute.base_url),
      model: stringValue(rawRoute.model) ?? modelForRole(config, role)
    };
  }
  return routes;
}

function runtimeProviderRoutes(driver: ModelDriver): Partial<Record<ProviderRole, ProviderRouteFingerprint>> {
  const routeTable = (driver as { routes?: unknown }).routes;
  if (!isRecord(routeTable)) return {};
  const routes: Partial<Record<ProviderRole, ProviderRouteFingerprint>> = {};
  for (const role of providerRoles) {
    const route = routeTable[role];
    if (!isRecord(route)) continue;
    const routeDriver = route.driver as ModelDriver | undefined;
    routes[role] = {
      provider: routeDriver ? providerLabel(routeDriver) : undefined,
      baseUrl: routeDriver ? providerBaseUrl(routeDriver) : undefined,
      model: stringValue(route.model)
    };
  }
  return routes;
}

function providerRouteFingerprint(driver: ModelDriver): string | undefined {
  const value = driver as { routeFingerprint?: unknown; config?: { routeFingerprint?: unknown }; baseDriver?: ModelDriver };
  if (typeof value.routeFingerprint === "string") return value.routeFingerprint;
  if (typeof value.config?.routeFingerprint === "string") return value.config.routeFingerprint;
  if (value.baseDriver) return providerRouteFingerprint(value.baseDriver);
  return undefined;
}

function providerBaseUrl(driver: ModelDriver): string | undefined {
  const value = driver as { baseUrl?: unknown; config?: { baseUrl?: unknown }; baseDriver?: ModelDriver };
  if (typeof value.baseUrl === "string") return value.baseUrl;
  if (typeof value.config?.baseUrl === "string") return value.config.baseUrl;
  if (value.baseDriver) return providerBaseUrl(value.baseDriver);
  return undefined;
}

function modelForRole(config: RunConfig, role: ProviderRole): string | undefined {
  if (role === "generator") return config.generatorModel;
  if (role === "mutator") return config.mutatorModel;
  if (role === "judge") return config.judgeModel;
  return config.finalizerModel;
}

function routeLabel(route: ProviderRouteFingerprint): string {
  return [route.provider, route.baseUrl, route.model].filter(Boolean).join("/") || "provider route";
}

function providerMismatch(message: string): never {
  resumeConfigError(message, "resume.provider_mismatch", "Use the same provider configuration that created config.json.");
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readRequiredConfig(runDir: string): Promise<Record<string, unknown>> {
  const config = await readOptionalJson<Record<string, unknown>>(runDir, runArtifactFiles.config);
  if (!config) {
    resumeConfigError(
      "Run directory is missing config.json; cannot replay safely.",
      "resume.config_missing",
      "Resume only from a DeepThonk run directory with config.json."
    );
  }
  return config;
}

async function readOptionalJson<T>(runDir: string, fileName: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(join(runDir, fileName), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isLiveWorker(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function rankPopulation(population: Candidate[], scores: BtScore[]): Candidate[] {
  const order = new Map(scores.map((score) => [score.candidateId, score.rank]));
  return [...population].sort((left, right) => {
    return (order.get(left.id) ?? Number.POSITIVE_INFINITY) - (order.get(right.id) ?? Number.POSITIVE_INFINITY);
  });
}

export function topQuartile(ranked: Candidate[]): Candidate[] {
  return ranked.slice(0, Math.ceil(ranked.length / 4));
}

export function bottomQuartile(ranked: Candidate[]): Set<string> {
  return new Set(ranked.slice(ranked.length - Math.floor(ranked.length / 4)).map((candidate) => candidate.id));
}

export function copyElites(elites: Candidate[], generation: number): Candidate[] {
  return elites.map((candidate, index) => ({
    ...candidate,
    id: `g${generation}_elite_${index}_${candidate.id}`,
    generation,
    parentId: candidate.id,
    kind: "elite-copy",
    status: "elite",
    metadata: {
      ...candidate.metadata,
      createdAt: new Date().toISOString()
    }
  }));
}

export function keepPopulationSize(population: Candidate[], n: number): Candidate[] {
  return population.slice(0, n);
}

async function traceDiscardedCandidates(
  trace: TraceStore,
  ranked: Candidate[],
  carriedIds: Set<string>,
  bottomQuartileIds: Set<string>,
  generation: number
): Promise<void> {
  for (const candidate of ranked) {
    if (carriedIds.has(candidate.id)) continue;
    const discardReason = bottomQuartileIds.has(candidate.id) ? "bottom_quartile" : "rounding_trim";
    await trace.writeCandidate({
      ...candidate,
      status: "discarded",
      metadata: {
        ...candidate.metadata,
        discardReason,
        discardedAt: new Date().toISOString()
      }
    });
    await trace.event({ type: "candidate.discarded", candidate_id: candidate.id, generation, reason: discardReason });
  }
}

async function generateInitialPopulation(
  config: RunConfig,
  driver: ModelDriver,
  trace: TraceStore,
  rng: Rng,
  runId: string,
  tracker: BudgetTracker,
  guards: RunGuards
): Promise<Candidate[]> {
  const jobs = Array.from({ length: config.profile.n }, (_, index) => ({
    index,
    id: `g0_c${index}_${rng.id("c")}`,
    prompt: generatePrompt(config.task, config.rubric, config.promptStyle, config.promptOverrides?.generate)
  }));
  const candidates = await runLimitedPhase(
    jobs.map((job) => async () => {
        const reservation = await guards.beforeCall("initial population call");
        let result: ModelTextResult;
        try {
          result = await driver.generate({
            task: config.task,
            rubric: config.rubric,
            model: config.generatorModel,
            temperature: config.profile.sampleTemperature,
            candidateIndex: job.index,
            prompt: job.prompt
          });
        } catch (error) {
          await recordFailedInvocation({
            tracker,
            reservation,
            trace,
            phase: "gen0_initial",
            role: "generator",
            provider: config.provider,
            model: config.generatorModel,
            error
          });
          throw error;
        }
        const delta = tracker.record(result, { provider: config.provider, model: config.generatorModel }, reservation);
        await trace.writeUsage(buildUsageRecord({
          phase: "gen0_initial",
          role: "generator",
          result,
          delta,
          provider: result.provider ?? config.provider,
          model: result.model ?? config.generatorModel
        }));
        await guards.afterCall("initial population call");
        const candidate: Candidate = {
          id: job.id,
          generation: 0,
          kind: "initial",
          content: result.text,
          status: "generated",
          metadata: resultMetadata(result, config, job.prompt)
        };
        await trace.writeCandidate(candidate);
        await trace.event({ type: "candidate.generated", run_id: runId, candidate_id: candidate.id });
        return candidate;
      }),
    config.concurrency.generate
  );
  return candidates;
}

async function judgePairs(args: {
  config: RunConfig;
  driver: ModelDriver;
  trace: TraceStore;
  rng: Rng;
  runId: string;
  generation: number | "final";
  pairs: Pair[];
  population: Candidate[];
  tracker: BudgetTracker;
  guards: RunGuards;
}): Promise<Comparison[]> {
  const byId = new Map(args.population.map((candidate) => [candidate.id, candidate]));
  const jobs = args.pairs.map((pair, pairIndex) => {
    const originalA = byId.get(pair.a);
    const originalB = byId.get(pair.b);
    if (!originalA || !originalB) throw new ConfigError(`Pair referenced missing candidate: ${pair.a}, ${pair.b}.`);
    const swap = args.rng.bool();
    const presentedA = swap ? originalB : originalA;
    const presentedB = swap ? originalA : originalB;
    return {
      pairIndex,
      originalA,
      originalB,
      presentedA,
      presentedB,
      id: `${args.generation}_cmp_${pairIndex}_${args.rng.id("cmp")}`,
      prompt: comparePrompt(args.config.task, presentedA, presentedB, args.config.rubric, args.config.promptStyle, args.config.promptOverrides?.compare)
    };
  });
  const comparisons = await runLimitedPhase(
    jobs.map((job) => async () => {
        let parsed: z.infer<typeof compareOutputSchema> | undefined;
        let rawOutput: unknown;
        let invalidJson = false;
        let resultModel: string | undefined;
        let resultProvider: string | undefined;
        let resultRetryCount = 0;
        let jsonParseFailures = 0;
        let inputTokens = 0;
        let inputCacheHitTokens = 0;
        let inputCacheMissTokens = 0;
        let outputTokens = 0;
        let totalTokens = 0;

        for (let attempt = 0; attempt <= args.config.retry.invalidJsonRetries; attempt += 1) {
          const reservation = await args.guards.beforeCall(`${args.generation} comparison call`);
          let result: ModelTextResult;
          try {
            result = await args.driver.compare({
              task: args.config.task,
              rubric: args.config.rubric,
              model: args.config.judgeModel,
              temperature: args.config.profile.judgeTemperature,
              candidateA: job.presentedA,
              candidateB: job.presentedB,
              prompt: job.prompt
            });
          } catch (error) {
            await recordFailedInvocation({
              tracker: args.tracker,
              reservation,
              trace: args.trace,
              phase: args.generation === "final" ? "final_judge" : `gen${args.generation}_judge`,
              role: "judge",
              provider: args.config.provider,
              model: args.config.judgeModel,
              error
            });
            throw error;
          }
          const delta = args.tracker.record(result, { provider: args.config.provider, model: args.config.judgeModel }, reservation);
          await args.trace.writeUsage(buildUsageRecord({
            phase: args.generation === "final" ? "final_judge" : `gen${args.generation}_judge`,
            role: "judge",
            result,
            delta,
            provider: result.provider ?? args.config.provider,
            model: result.model ?? args.config.judgeModel
          }));
          await args.guards.afterCall(`${args.generation} comparison call`);
          inputTokens += result.usage?.inputTokens ?? 0;
          inputCacheHitTokens += result.usage?.inputCacheHitTokens ?? 0;
          inputCacheMissTokens += result.usage?.inputCacheMissTokens ?? 0;
          outputTokens += result.usage?.outputTokens ?? 0;
          totalTokens += result.usage?.totalTokens ?? (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
          rawOutput = args.config.output.includeRawModelOutputs ? result.raw ?? result.text : undefined;
          resultModel = result.model;
          resultProvider = result.provider;
          resultRetryCount += result.retryCount ?? 0;
          try {
            parsed = compareOutputSchema.parse(parseJsonObject(result.text));
            invalidJson = false;
            break;
          } catch {
            invalidJson = true;
            jsonParseFailures += 1;
          }
        }

        if (invalidJson || !parsed) {
          throw new ConfigError(
            `Judge produced ${jsonParseFailures} consecutive invalid-JSON responses (${args.config.retry.invalidJsonRetries + 1} attempts) for comparison ${job.id}. Refusing to synthesize a tie and pollute the ranking.`,
            {
              code: "judge.persistent_invalid_json",
              retryable: false,
              fix: "The judge model is producing unparseable output. Inspect the raw response (set output.includeRawModelOutputs: true), switch judge models, or raise retry.invalidJsonRetries if the failures are transient."
            }
          );
        }

        const comparison: Comparison = {
          id: job.id,
          runId: args.runId,
          generation: args.generation,
          candidateAId: job.presentedA.id,
          candidateBId: job.presentedB.id,
          presentedAOriginalId: job.presentedA.id,
          presentedBOriginalId: job.presentedB.id,
          winner: parsed.winner,
          confidence: parsed.confidence,
          critiqueForA: parsed.feedback_a ?? parsed.critique_for_A ?? "",
          critiqueForB: parsed.feedback_b ?? parsed.critique_for_B ?? "",
          selectionReason: parsed.selection_reason ?? "",
          rawOutput,
          model: resultModel,
          provider: resultProvider,
          metadata: compactMetadata({
            invalid_json_tie: invalidJson ? true : undefined,
            json_parse_failures: jsonParseFailures || undefined,
            model_call_count: jsonParseFailures + (parsed ? 1 : 0),
            input_tokens: inputTokens || undefined,
            input_cache_hit_tokens: inputCacheHitTokens || undefined,
            input_cache_miss_tokens: inputCacheMissTokens || undefined,
            output_tokens: outputTokens || undefined,
            total_tokens: totalTokens || undefined,
            scheduled_candidate_a_id: job.originalA.id,
            scheduled_candidate_b_id: job.originalB.id,
            provider_retry_count: resultRetryCount || undefined,
            prompt: args.config.output.includePrompts ? job.prompt : undefined
          })
        };
        await args.trace.writeComparison(comparison);
        await args.trace.event({
          type: "comparison.completed",
          run_id: args.runId,
          comparison_id: comparison.id,
          generation: args.generation
        });
        return comparison;
      }),
    args.config.concurrency.judge
  );
  return comparisons;
}

async function mutateSurvivors(args: {
  config: RunConfig;
  driver: ModelDriver;
  trace: TraceStore;
  generation: number;
  survivors: Candidate[];
  critiquesByCandidate: Map<string, string>;
  tracker: BudgetTracker;
  guards: RunGuards;
}): Promise<Candidate[]> {
  const mutants = await runLimitedPhase(
    args.survivors.map((candidate, index) => async () => {
        const critique = args.critiquesByCandidate.get(candidate.id) ?? "";
        const prompt = mutatePrompt(args.config.task, candidate, critique, args.config.rubric, args.config.promptStyle, args.config.promptOverrides?.mutate);
        const reservation = await args.guards.beforeCall(`generation ${args.generation} mutation call`);
        let result: ModelTextResult;
        try {
          result = await args.driver.mutate({
            task: args.config.task,
            rubric: args.config.rubric,
            model: args.config.mutatorModel,
            temperature: args.config.profile.mutateTemperature,
            candidate,
            critique,
            prompt
          });
        } catch (error) {
          await recordFailedInvocation({
            tracker: args.tracker,
            reservation,
            trace: args.trace,
            phase: `gen${args.generation}_mutate`,
            role: "mutator",
            provider: args.config.provider,
            model: args.config.mutatorModel,
            error
          });
          throw error;
        }
        const delta = args.tracker.record(result, { provider: args.config.provider, model: args.config.mutatorModel }, reservation);
        await args.trace.writeUsage(buildUsageRecord({
          phase: `gen${args.generation}_mutate`,
          role: "mutator",
          result,
          delta,
          provider: result.provider ?? args.config.provider,
          model: result.model ?? args.config.mutatorModel
        }));
        await args.guards.afterCall(`generation ${args.generation} mutation call`);
        const mutant: Candidate = {
          id: `g${args.generation}_m${index}_${candidate.id}`,
          generation: args.generation,
          parentId: candidate.id,
          kind: "mutation",
          content: result.text,
          status: "mutated",
          metadata: resultMetadata(result, args.config, prompt)
        };
        await args.trace.writeCandidate(mutant);
        await args.trace.event({ type: "candidate.mutated", candidate_id: mutant.id, parent_id: mutant.parentId });
        return mutant;
      }),
    args.config.concurrency.mutate
  );
  return mutants;
}

async function maybeFinalize(
  winner: Candidate,
  config: RunConfig,
  driver: ModelDriver,
  trace: TraceStore,
  tracker: BudgetTracker,
  guards: RunGuards
): Promise<string> {
  if (!config.finalizerModel || !driver.finalize) return winner.content;
  const reservation = await guards.beforeCall("finalization call");
  let result: ModelTextResult;
  try {
    result = await driver.finalize({
      task: config.task,
      rubric: config.rubric,
      model: config.finalizerModel,
      candidate: winner,
      prompt: finalizePrompt(config.task, winner, config.rubric, config.promptStyle, config.promptOverrides?.finalize)
    });
  } catch (error) {
    await recordFailedInvocation({
      tracker,
      reservation,
      trace,
      phase: "finalize",
      role: "finalizer",
      provider: config.provider,
      model: config.finalizerModel,
      error
    });
    throw error;
  }
  const delta = tracker.record(result, { provider: config.provider, model: config.finalizerModel }, reservation);
  await trace.writeUsage(buildUsageRecord({
    phase: "finalize",
    role: "finalizer",
    result,
    delta,
    provider: result.provider ?? config.provider,
    model: result.model ?? config.finalizerModel
  }));
  await guards.afterCall("finalization call");
  await trace.event({ type: "finalized", winner_id: winner.id, model: result.model, provider: result.provider });
  return result.text;
}

function resultMetadata(result: {
  model?: string;
  provider?: string;
  usage?: { inputTokens?: number; inputCacheHitTokens?: number; inputCacheMissTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs?: number;
  retryCount?: number;
  raw?: unknown;
}, config: RunConfig, prompt?: { system: string; user: string }): Candidate["metadata"] {
  return compactMetadata({
    model: result.model,
    provider: result.provider,
    promptTokens: result.usage?.inputTokens,
    promptCacheHitTokens: result.usage?.inputCacheHitTokens,
    promptCacheMissTokens: result.usage?.inputCacheMissTokens,
    completionTokens: result.usage?.outputTokens,
    totalTokens: result.usage?.totalTokens,
    latencyMs: result.latencyMs,
    retryCount: result.retryCount,
    rawOutput: config.output.includeRawModelOutputs ? result.raw : undefined,
    prompt: config.output.includePrompts ? prompt : undefined,
    createdAt: new Date().toISOString()
  }) as Candidate["metadata"];
}

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function summaryProfile(profile: RunConfig["profile"]): Record<string, number> {
  return {
    n: profile.n,
    k: profile.k,
    t: profile.t,
    m: profile.m,
    lambda: profile.lambda,
    sample_temperature: profile.sampleTemperature,
    mutate_temperature: profile.mutateTemperature,
    judge_temperature: profile.judgeTemperature
  };
}

function summaryProfileName(profile: RunConfig["profile"]): BuiltInProfileName | null {
  for (const name of ["quick", "balanced", "paper"] as const) {
    if (profilesEqual(profile, builtInProfiles[name])) return name;
  }
  return null;
}

function profilesEqual(left: RunConfig["profile"], right: RunConfig["profile"]): boolean {
  return (
    left.n === right.n &&
    left.k === right.k &&
    left.t === right.t &&
    left.m === right.m &&
    left.lambda === right.lambda &&
    left.sampleTemperature === right.sampleTemperature &&
    left.mutateTemperature === right.mutateTemperature &&
    left.judgeTemperature === right.judgeTemperature
  );
}

function summaryModels(config: RunConfig): { generator: string; mutator: string; judge: string; finalizer: string | null } {
  return {
    generator: config.generatorModel,
    mutator: config.mutatorModel,
    judge: config.judgeModel,
    finalizer: config.finalizerModel ?? null
  };
}

function buildUsageRecord(args: {
  phase: string;
  role: CallRole;
  result: ModelTextResult;
  delta: UsageDelta;
  provider?: string;
  model?: string;
  outcome?: "success" | "failed";
  errorCode?: string;
}): UsageRecord {
  return {
    schema_version: 1,
    ts: new Date().toISOString(),
    phase: args.phase,
    role: args.role,
    provider: args.provider,
    model: args.model,
    input_tokens: args.delta.inputTokens,
    input_cache_hit_tokens: args.delta.inputCacheHitTokens,
    input_cache_miss_tokens: args.delta.inputCacheMissTokens,
    output_tokens: args.delta.outputTokens,
    total_tokens: args.delta.totalTokens,
    input_usd: args.delta.inputUsd,
    output_usd: args.delta.outputUsd,
    total_usd: args.delta.usd,
    latency_ms: args.result.latencyMs,
    retry_count: args.result.retryCount,
    outcome: args.outcome,
    error_code: args.errorCode
  };
}

async function recordFailedInvocation(args: {
  tracker: BudgetTracker;
  reservation: CallReservation;
  trace: TraceStore;
  phase: string;
  role: CallRole;
  provider?: string;
  model: string;
  error: unknown;
}): Promise<void> {
  const delta = args.tracker.failCall(args.reservation);
  await bestEffortTraceWrite("failed call usage", () =>
    args.trace.writeUsage(
      buildUsageRecord({
        phase: args.phase,
        role: args.role,
        result: { text: "" },
        delta,
        provider: args.provider,
        model: args.model,
        outcome: "failed",
        errorCode: args.error instanceof DeepThonkError ? args.error.code : args.error instanceof Error ? args.error.name : "unknown_error"
      })
    )
  );
}

function enforceBudget(config: RunConfig): void {
  const plan = planBudget(config.profile, {
    invalidJsonRetries: config.retry.invalidJsonRetries,
    includeFinalizer: Boolean(config.finalizerModel)
  });
  const plannedCalls = plan.calls + plan.finalizer_calls;
  if (config.budget?.maxCalls !== undefined && plannedCalls > config.budget.maxCalls) {
    throw new BudgetExceededError(`Planned call count ${plannedCalls} exceeds maxCalls ${config.budget.maxCalls}.`, {
      code: "budget.planned_calls_exceeded",
      fix: "Raise maxCalls or use a smaller profile."
    });
  }
}

function cloneUsage(usage: BudgetUsage): BudgetUsage {
  return {
    ...emptyUsage(),
    ...usage
  };
}

async function bestEffortTraceWrite(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    process.stderr.write(`deepthonk: failed to persist ${label}: ${(error as Error).message}\n`);
  }
}

function serializeRunError(error: unknown): RunStatus["error"] {
  if (error instanceof DeepThonkError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fix: error.fix
    };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}

async function currentPackageVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function sameMajorMinor(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const parse = (version: string): [number, number] | undefined => {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2])];
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}
