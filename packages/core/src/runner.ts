import pLimit from "p-limit";
import { z } from "zod";
import { fitBradleyTerry } from "./bradleyTerry.js";
import { BudgetTracker } from "./budgetTracker.js";
import { planBudget, validateProfile } from "./budget.js";
import { BudgetExceededError, CancelledError, ConfigError, DeepThonkError } from "./errors.js";
import { parseJsonObject } from "./json.js";
import { emptyUsage, type BudgetUsage, type RunLifecycleState, type RunStatus } from "./lifecycle.js";
import { makeKRegularPairs, type Pair } from "./pairScheduler.js";
import { comparePrompt, finalizePrompt, generatePrompt, mutatePrompt } from "./prompts.js";
import { createRng, type Rng } from "./rng.js";
import {
  runConfigSchema,
  type BtScore,
  type Candidate,
  type Comparison,
  type ModelDriver,
  type ModelTextResult,
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
  shouldCancel?: () => boolean | Promise<boolean>;
}

interface RunGuards {
  beforeCall(phase: string): Promise<void>;
  afterCall(phase: string): Promise<void>;
}

export async function runDeepThonk(configInput: RunConfig, driver: ModelDriver, control: RunControl = {}): Promise<RunResult> {
  const config = runConfigSchema.parse(configInput);
  validateProfile(config.profile);
  enforceBudget(config);

  const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.abs(config.seed)}`;
  const trace = new TraceStore(config.runDir);
  const rng = createRng(config.seed);
  const tracker = new BudgetTracker(config);
  const startedAt = new Date().toISOString();
  await trace.init(config, runId);
  let stopped = false;
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
        fix: "Start a new run with a fresh output directory. Automatic replay is not implemented yet."
      });
    }
  };
  const assertBudget = async (phase: string): Promise<void> => {
    try {
      tracker.assertWithinBudget(phase);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        stopped = true;
        await trace.event({ type: "budget.exceeded", phase, usage: cloneUsage(tracker.usage), error: serializeRunError(error) });
      }
      throw error;
    }
  };
  const guards: RunGuards = {
    async beforeCall(phase: string): Promise<void> {
      if (stopped) throw new BudgetExceededError(`Run already stopped before ${phase}.`, { code: "budget.stopped" });
      await assertNotCancelled(phase);
      await assertBudget(phase);
    },
    async afterCall(phase: string): Promise<void> {
      await assertNotCancelled(phase);
      await assertBudget(phase);
    }
  };

  try {
    await writeStatus("running", "initialized");
    await assertNotCancelled("initial population");
    let population = await generateInitialPopulation(config, driver, trace, rng, runId, tracker, guards);
    await trace.writePopulation(0, population);
    await assertBudget("initial population");
    await writeStatus("running", "population_completed", { generation: 0 });

    for (let gen = 1; gen <= config.profile.t; gen += 1) {
      await assertNotCancelled(`generation ${gen} comparisons`);
      await writeStatus("running", "generation_comparisons", { generation: gen });
      const pairs = makeKRegularPairs(
        population.map((candidate) => candidate.id),
        config.profile.k,
        rng
      );
      const comparisons = await judgePairs({
        config,
        driver,
        trace,
        rng,
        runId,
        generation: gen,
        pairs,
        population,
        tracker,
        guards
      });

      const scores = fitBradleyTerry(population, comparisons, config.profile.lambda, gen);
      await trace.writeScores(gen, scores);
      await assertBudget(`generation ${gen} comparisons`);

      const ranked = rankPopulation(population, scores);
      const elites = topQuartile(ranked);
      const discarded = bottomQuartile(ranked);
      const survivors = ranked.filter((candidate) => !discarded.has(candidate.id));
      const mutationParents = survivors.slice(0, config.profile.n - elites.length);
      const critiquesByCandidate = aggregateCritiques(population, comparisons);

      await assertNotCancelled(`generation ${gen} mutation`);
      await writeStatus("running", "generation_mutation", { generation: gen });
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
      await writeStatus("running", "generation_completed", { generation: gen });
    }

    await assertNotCancelled("final ranking");
    await writeStatus("running", "final_ranking", { generation: "final" });
    const finalPairs = makeKRegularPairs(
      population.map((candidate) => candidate.id),
      config.profile.m,
      rng
    );
    const finalComparisons = await judgePairs({
      config,
      driver,
      trace,
      rng,
      runId,
      generation: "final",
      pairs: finalPairs,
      population,
      tracker,
      guards
    });
    const finalScores = fitBradleyTerry(population, finalComparisons, config.profile.lambda, "final");
    await trace.writeScores("final", finalScores);
    await assertBudget("final ranking");
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
      calls: tracker.usage.calls,
      usage: cloneUsage(tracker.usage),
      ranked_winner_answer_path: "artifacts/winner.txt",
      final_answer_path: "artifacts/final.txt",
      final_answer_is_postprocessed: finalAnswer !== winner.content,
      final_scores: finalScores,
      completed_at: completedAt
    };
    await trace.writeSummary(summary, finalAnswer, winner.content);
    await trace.event({ type: "run.completed", winner_id: winner.id, completed_at: completedAt });
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
    const serialized = serializeRunError(error);
    const state: RunLifecycleState =
      error instanceof CancelledError ? "cancelled" : error instanceof BudgetExceededError ? "budget_exceeded" : "failed";
    await trace.event({ type: `run.${state}`, run_id: runId, error: serialized, updated_at: new Date().toISOString() });
    await writeStatus(state, state, { error: serialized });
    throw error;
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

async function generateInitialPopulation(
  config: RunConfig,
  driver: ModelDriver,
  trace: TraceStore,
  rng: Rng,
  runId: string,
  tracker: BudgetTracker,
  guards: RunGuards
): Promise<Candidate[]> {
  const limit = pLimit(config.concurrency.generate);
  const jobs = Array.from({ length: config.profile.n }, (_, index) => ({
    index,
    id: `g0_c${index}_${rng.id("c")}`,
    prompt: generatePrompt(config.task, config.rubric, config.promptStyle)
  }));
  const candidates = await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        await guards.beforeCall("initial population call");
        const result = await driver.generate({
          task: config.task,
          rubric: config.rubric,
          model: config.generatorModel,
          temperature: config.profile.sampleTemperature,
          candidateIndex: job.index,
          prompt: job.prompt
        });
        tracker.record(result, { provider: config.provider, model: config.generatorModel });
        await guards.afterCall("initial population call");
        const candidate: Candidate = {
          id: job.id,
          generation: 0,
          kind: "initial",
          content: result.text,
          status: "generated",
          metadata: resultMetadata(result, config, job.prompt)
        };
        return candidate;
      })
    )
  );
  for (const candidate of candidates) {
    await trace.writeCandidate(candidate);
    await trace.event({ type: "candidate.generated", run_id: runId, candidate_id: candidate.id });
  }
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
  const limit = pLimit(args.config.concurrency.judge);
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
      prompt: comparePrompt(args.config.task, presentedA, presentedB, args.config.rubric, args.config.promptStyle)
    };
  });
  const comparisons = await Promise.all(
    jobs.map((job) =>
      limit(async () => {
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
          await args.guards.beforeCall(`${args.generation} comparison call`);
          const result = await args.driver.compare({
            task: args.config.task,
            rubric: args.config.rubric,
            model: args.config.judgeModel,
            temperature: args.config.profile.judgeTemperature,
            candidateA: job.presentedA,
            candidateB: job.presentedB,
            prompt: job.prompt
          });
          args.tracker.record(result, { provider: args.config.provider, model: args.config.judgeModel });
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

        const comparison: Comparison = {
          id: job.id,
          runId: args.runId,
          generation: args.generation,
          candidateAId: job.presentedA.id,
          candidateBId: job.presentedB.id,
          presentedAOriginalId: job.presentedA.id,
          presentedBOriginalId: job.presentedB.id,
          winner: parsed?.winner ?? "tie",
          confidence: parsed?.confidence,
          critiqueForA: parsed?.feedback_a ?? parsed?.critique_for_A ?? "Invalid comparison JSON; recorded as tie.",
          critiqueForB: parsed?.feedback_b ?? parsed?.critique_for_B ?? "Invalid comparison JSON; recorded as tie.",
          selectionReason: parsed?.selection_reason ?? "invalid_json_tie",
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
        return comparison;
      })
    )
  );
  for (const comparison of comparisons) {
    await args.trace.writeComparison(comparison);
    await args.trace.event({
      type: "comparison.completed",
      run_id: args.runId,
      comparison_id: comparison.id,
      generation: args.generation
    });
  }
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
  const limit = pLimit(args.config.concurrency.mutate);
  const mutants = await Promise.all(
    args.survivors.map((candidate, index) =>
      limit(async () => {
        const critique = args.critiquesByCandidate.get(candidate.id) ?? "";
        const prompt = mutatePrompt(args.config.task, candidate, critique, args.config.rubric, args.config.promptStyle);
        await args.guards.beforeCall(`generation ${args.generation} mutation call`);
        const result = await args.driver.mutate({
          task: args.config.task,
          rubric: args.config.rubric,
          model: args.config.mutatorModel,
          temperature: args.config.profile.mutateTemperature,
          candidate,
          critique,
          prompt
        });
        args.tracker.record(result, { provider: args.config.provider, model: args.config.mutatorModel });
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
        return mutant;
      })
    )
  );
  for (const mutant of mutants) {
    await args.trace.writeCandidate(mutant);
    await args.trace.event({ type: "candidate.mutated", candidate_id: mutant.id, parent_id: mutant.parentId });
  }
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
  await guards.beforeCall("finalization call");
  const result = await driver.finalize({
    task: config.task,
    rubric: config.rubric,
    model: config.finalizerModel,
    candidate: winner,
    prompt: finalizePrompt(config.task, winner, config.rubric)
  });
  tracker.record(result, { provider: config.provider, model: config.finalizerModel });
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

function enforceBudget(config: RunConfig): void {
  const plan = planBudget(config.profile);
  const plannedCalls = plan.calls + (config.finalizerModel ? 1 : 0);
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
