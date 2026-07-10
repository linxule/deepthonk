import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runArtifactFiles } from "./artifacts.js";
import { fitBradleyTerry } from "./bradleyTerry.js";
import { BudgetTracker } from "./budgetTracker.js";
import { ConfigError } from "./errors.js";
import { claimRunLockOwnership, releaseRunLock, type RunStatus, type UsageRecord } from "./lifecycle.js";
import { makeKRegularPairs } from "./pairScheduler.js";
import { createRng } from "./rng.js";
import type { BtScore, Candidate, Comparison, PhaseName, RunConfig } from "./schemas.js";
import { phaseCompletedEventSchema } from "./schemas.js";

export const pruneSentinelFile = ".prune-in-progress";

export interface ResumeTrace {
  events: Array<Record<string, unknown>>;
  candidates: Candidate[];
  comparisons: Comparison[];
  scores: BtScore[];
  populations: Map<number, Candidate[]>;
  usage: UsageRecord[];
}

export interface PhaseCursor {
  phase: PhaseName | "summary";
  generation?: number | "final";
}

export interface InternalResumePlan {
  completed: Set<string>;
  nextPhase: PhaseCursor;
}

export interface ResumePlanStatus {
  status: "completed" | "resumable";
  message: string;
  run_id?: string;
  run_dir: string;
  phase?: PhaseName | "summary";
  generation?: number | "final";
  safe_to_continue: boolean;
  plan?: {
    next_phase: PhaseName | "summary";
    generation?: number | "final";
    completed_phases: Array<{ phase: PhaseName; generation?: number }>;
  };
}

export async function readResumeTrace(runDir: string): Promise<ResumeTrace> {
  const files = await readdir(runDir).catch(() => []);
  const populations = new Map<number, Candidate[]>();
  for (const file of files) {
    const match = /^population-(\d+)\.json$/.exec(file);
    if (!match) continue;
    populations.set(Number(match[1]), await readJson<Candidate[]>(runDir, file));
  }

  return {
    events: await readJsonl<Record<string, unknown>>(runDir, runArtifactFiles.trace),
    candidates: await readJsonl<Candidate>(runDir, runArtifactFiles.candidates),
    comparisons: await readJsonl<Comparison>(runDir, runArtifactFiles.comparisons),
    scores: await readJsonl<BtScore>(runDir, runArtifactFiles.scores),
    populations,
    usage: await readJsonl<UsageRecord>(runDir, runArtifactFiles.usage)
  };
}

export function resolveResumeRunId(
  config: RunConfig & { run_id?: string },
  status: RunStatus | undefined,
  events: Array<Record<string, unknown>>
): string {
  if (typeof config.run_id === "string") return config.run_id;
  if (typeof config.runId === "string") return config.runId;
  if (typeof status?.run_id === "string") return status.run_id;
  for (const event of events) {
    if (event.type === "run.started" && typeof event.run_id === "string") return event.run_id;
  }
  return `run_resume_${Math.abs(config.seed)}`;
}

export function buildResumePlan(config: RunConfig, events: Array<Record<string, unknown>>): InternalResumePlan {
  const expected = expectedPhaseSequence(config);
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type !== "phase.completed") continue;
    const parsed = phaseCompletedEventSchema.safeParse(event);
    if (!parsed.success) {
      resumeConfigError(
        "Trace contains a malformed phase.completed marker.",
        "resume.phase_marker_invalid",
        "Inspect events.jsonl; phase markers must use valid phase names and generation numbers."
      );
    }
    const key = strictPhaseKey(config, parsed.data.phase, parsed.data.generation);
    const next = expected[completed.size];
    if (key !== next) {
      const detail = completed.has(key) ? `duplicate marker ${key}` : `marker ${key} before ${next ?? "the end of the run"}`;
      resumeConfigError(
        `Trace phase markers are not a strict completed prefix: ${detail}.`,
        "resume.phase_order_invalid",
        "Restore events.jsonl from the original run or start a fresh run."
      );
    }
    completed.add(key);
  }
  return { completed, nextPhase: phaseCursorForKey(expected[completed.size]) };
}

export function resumeConfigError(message: string, code: string, fix?: string): never {
  throw new ConfigError(message, { code, retryable: false, fix });
}

export function assertNoLegacyRedactedBudget(config: Record<string, unknown>): void {
  const paths = legacyRedactedBudgetPaths(config);
  if (paths.length === 0) return;
  resumeConfigError(
    `Stored config.json has legacy-redacted numeric budget fields: ${paths.join(", ")}.`,
    "resume.legacy_redacted_budget",
    "Use `deepthonk repair-budget` or MCP `deepthonk.repair_budget` with explicit numeric replacements for exactly these fields; DeepThonk will not guess budget caps."
  );
}

export async function repairLegacyBudgetConfig(runDir: string, replacements: Record<string, number>): Promise<string[]> {
  const claim = await claimRunLockOwnership(runDir, "config-repair");
  if (!claim) {
    throw new ConfigError(`Run directory is already claimed: ${runDir}`, {
      code: "run.directory_locked",
      retryable: false,
      fix: "Wait for the active worker to stop before repairing config.json."
    });
  }
  try {
    const config = await readJson<Record<string, unknown>>(runDir, runArtifactFiles.config);
    const affected = legacyRedactedBudgetPaths(config).sort();
    const supplied = Object.keys(replacements).sort();
    if (affected.length === 0) {
      resumeConfigError("Stored config.json has no legacy-redacted numeric budget fields.", "resume.budget_repair_not_needed");
    }
    if (!isDeepStrictEqual(affected, supplied)) {
      resumeConfigError(
        `Budget repair requires replacements for exactly: ${affected.join(", ")}.`,
        "resume.budget_repair_incomplete",
        "Supply every listed dotted path and no unrelated fields."
      );
    }
    const repaired = structuredClone(config);
    for (const path of affected) {
      const value = replacements[path];
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        resumeConfigError(
          `Replacement for ${path} must be a positive integer.`,
          "resume.budget_repair_invalid",
          "Use the original numeric cap from the run configuration."
        );
      }
      setDottedPath(repaired, path, value);
    }
    const parsed = JSON.stringify(repaired, null, 2) + "\n";
    const target = join(runDir, runArtifactFiles.config);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, parsed, "utf8");
    await rename(temporary, target);
    await writeFile(
      join(runDir, runArtifactFiles.trace),
      `${JSON.stringify({ type: "config.repaired", fields: affected, repaired_at: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "a" }
    );
    return affected;
  } finally {
    await releaseRunLock(runDir, claim.claimId);
  }
}

function legacyRedactedBudgetPaths(config: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const budget = config.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) return paths;
  for (const key of ["maxCalls", "maxInputTokens", "maxOutputTokens"] as const) {
    if ((budget as Record<string, unknown>)[key] === "[redacted]") paths.push(`budget.${key}`);
  }
  const prices = (budget as Record<string, unknown>).prices;
  if (Array.isArray(prices)) {
    for (let index = 0; index < prices.length; index += 1) {
      const price = prices[index];
      if (price && typeof price === "object" && !Array.isArray(price)) {
        if ((price as Record<string, unknown>).longContextThresholdTokens === "[redacted]") {
          paths.push(`budget.prices.${index}.longContextThresholdTokens`);
        }
      }
    }
  }
  return paths;
}

function setDottedPath(target: Record<string, unknown>, path: string, value: number): void {
  const parts = path.split(".");
  let current: unknown = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    current = Array.isArray(current)
      ? current[Number(part)]
      : current && typeof current === "object"
        ? (current as Record<string, unknown>)[part]
        : undefined;
  }
  const key = parts.at(-1)!;
  if (Array.isArray(current)) current[Number(key)] = value;
  else (current as Record<string, unknown>)[key] = value;
}

export function toResumePlanStatus(runDir: string, runId: string, plan: InternalResumePlan): ResumePlanStatus {
  const completedPhases = completedPhaseEntries(plan.completed);
  const done = plan.nextPhase.phase === "summary";
  return {
    status: done ? "completed" : "resumable",
    message: done
      ? "Trace has all phase completion markers."
      : `Run can resume from ${plan.nextPhase.phase}${plan.nextPhase.generation !== undefined ? `:${plan.nextPhase.generation}` : ""}.`,
    run_id: runId,
    run_dir: runDir,
    phase: plan.nextPhase.phase,
    generation: plan.nextPhase.generation,
    safe_to_continue: !done,
    plan: {
      next_phase: plan.nextPhase.phase,
      generation: plan.nextPhase.generation,
      completed_phases: completedPhases
    }
  };
}

export function pruneTraceToPlan(trace: ResumeTrace, plan: InternalResumePlan): ResumeTrace {
  const candidates = trace.candidates.filter((candidate) => keepCandidate(candidate, plan.completed));
  const comparisons = trace.comparisons.filter((comparison) => plan.completed.has(phaseKeyForComparison(comparison)));
  const scores = trace.scores.filter((score) => plan.completed.has(phaseKeyForScore(score)));
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const comparisonIds = new Set(comparisons.map((comparison) => comparison.id));

  return {
    events: trace.events.filter((event) => keepEvent(event, plan.completed, candidateIds, comparisonIds)),
    candidates,
    comparisons,
    scores,
    populations: new Map([...trace.populations].filter(([generation]) => keepPopulationGeneration(generation, plan.completed))),
    // Usage is append-only accounting. Calls made during an interrupted phase
    // still consumed provider budget and must survive conservative v1 replay.
    usage: trace.usage
  };
}

export function buildPopulationMap(
  config: RunConfig,
  populations: Map<number, Candidate[]>,
  candidates: Candidate[],
  plan: InternalResumePlan
): Map<number, Candidate[]> {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates.filter((candidate) => candidate.status !== "discarded")) {
    assertCandidateShape(candidate);
    if (byId.has(candidate.id)) {
      resumeConfigError(
        `candidates.jsonl contains duplicate active candidate ID ${candidate.id}.`,
        "resume.candidates_invalid",
        "Restore candidates.jsonl from a single run or start a fresh run."
      );
    }
    byId.set(candidate.id, candidate);
  }
  const populationByGeneration = new Map<number, Candidate[]>();
  for (const generation of requiredPopulationGenerations(config, plan.completed)) {
    const population = populations.get(generation);
    if (!population) {
      resumeConfigError(
        `Resume trace is missing population-${generation}.json for a completed phase boundary.`,
        "resume.population_missing",
        "Restore the population snapshot or start a fresh run."
      );
    }
    if (population.length !== config.profile.n) {
      resumeConfigError(
        `population-${generation}.json has ${population.length} candidates; expected ${config.profile.n}.`,
        "resume.population_invalid",
        "Inspect the run directory for a truncated or mixed trace."
      );
    }
    const populationIds = new Set<string>();
    for (const candidate of population) {
      assertCandidateShape(candidate);
      if (candidate.generation !== generation || populationIds.has(candidate.id)) {
        resumeConfigError(
          `population-${generation}.json has an invalid or duplicate candidate ${candidate.id}.`,
          "resume.population_invalid",
          "Inspect the population snapshot for mixed generations or duplicate IDs."
        );
      }
      populationIds.add(candidate.id);
      const traced = byId.get(candidate.id);
      if (!traced) {
        resumeConfigError(
          `population-${generation}.json references missing candidate ${candidate.id}.`,
          "resume.population_invalid",
          "Restore candidates.jsonl or start a fresh run."
        );
      }
      if (!isDeepStrictEqual(candidate, traced)) {
        resumeConfigError(
          `population-${generation}.json candidate ${candidate.id} does not match candidates.jsonl.`,
          "resume.population_mismatch",
          "Restore the matching population snapshot and candidate trace from the same run."
        );
      }
    }
    populationByGeneration.set(generation, population);
  }
  return populationByGeneration;
}

export function groupComparisons(comparisons: Comparison[]): Map<number | "final", Comparison[]> {
  const grouped = new Map<number | "final", Comparison[]>();
  for (const comparison of comparisons) {
    const bucket = grouped.get(comparison.generation) ?? [];
    bucket.push(comparison);
    grouped.set(comparison.generation, bucket);
  }
  return grouped;
}

export function reconstructScores(
  config: RunConfig,
  populationByGeneration: Map<number, Candidate[]>,
  comparisonsByGeneration: Map<number | "final", Comparison[]>,
  existingScores: BtScore[],
  plan: InternalResumePlan,
  runId?: string
): Map<number | "final", BtScore[]> {
  const scoresByGeneration = new Map<number | "final", BtScore[]>();
  for (let gen = 1; gen <= config.profile.t; gen += 1) {
    if (!plan.completed.has(phaseKey("generation_judging", gen))) continue;
    const population = requirePopulation(populationByGeneration, gen - 1);
    const comparisons = comparisonsByGeneration.get(gen) ?? [];
    validateComparisons(config, gen, population, comparisons, runId);
    const reconstructed = fitBradleyTerry(population, comparisons, config.profile.lambda, gen);
    sanityCheckScores(existingScores, gen, population, reconstructed);
    scoresByGeneration.set(gen, reconstructed);
  }
  if (plan.completed.has("final_judging")) {
    const population = requirePopulation(populationByGeneration, config.profile.t);
    const comparisons = comparisonsByGeneration.get("final") ?? [];
    validateComparisons(config, "final", population, comparisons, runId);
    const reconstructed = fitBradleyTerry(population, comparisons, config.profile.lambda, "final");
    sanityCheckScores(existingScores, "final", population, reconstructed);
    scoresByGeneration.set("final", reconstructed);
  }
  return scoresByGeneration;
}

export function replayBudgetUsage(config: RunConfig, usage: UsageRecord[]): BudgetTracker {
  const tracker = new BudgetTracker(config);
  let hasUsd = false;
  for (const record of usage) {
    validateUsageRecord(record);
    tracker.usage.calls += 1;
    tracker.usage.inputTokens += record.input_tokens;
    if (record.input_cache_hit_tokens !== undefined) {
      tracker.usage.inputCacheHitTokens = (tracker.usage.inputCacheHitTokens ?? 0) + record.input_cache_hit_tokens;
    }
    if (record.input_cache_miss_tokens !== undefined) {
      tracker.usage.inputCacheMissTokens = (tracker.usage.inputCacheMissTokens ?? 0) + record.input_cache_miss_tokens;
    }
    tracker.usage.outputTokens += record.output_tokens;
    tracker.usage.totalTokens += record.total_tokens;
    if (record.total_usd !== undefined) {
      hasUsd = true;
      tracker.usage.usd = (tracker.usage.usd ?? 0) + record.total_usd;
    }
  }
  if (!hasUsd) delete tracker.usage.usd;
  return tracker;
}

function validateUsageRecord(record: UsageRecord): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    resumeConfigError("usage.jsonl contains a non-object row.", "resume.usage_invalid", "Restore usage.jsonl from the original run.");
  }
  const phase = typeof record.phase === "string" ? record.phase : "";
  const expectedRole =
    phase === "gen0_initial"
      ? "generator"
      : phase === "final_judge" || /^gen\d+_judge$/.test(phase)
        ? "judge"
        : /^gen\d+_mutate$/.test(phase)
          ? "mutator"
          : phase === "finalize"
            ? "finalizer"
            : undefined;
  const requiredNumbers = [record.input_tokens, record.output_tokens, record.total_tokens];
  const validNumber = (value: number | undefined): boolean =>
    value === undefined || (Number.isFinite(value) && value >= 0);
  const validTokenNumber = (value: number | undefined): boolean => value === undefined || (Number.isSafeInteger(value) && value >= 0);
  const errorCodeValid =
    record.error_code === undefined ||
    (record.outcome === "failed" && /^[A-Za-z0-9._-]{1,128}$/.test(record.error_code));
  if (
    record.schema_version !== 1 ||
    expectedRole === undefined ||
    record.role !== expectedRole ||
    typeof record.ts !== "string" ||
    !Number.isFinite(Date.parse(record.ts)) ||
    typeof record.provider !== "string" || record.provider.length < 1 || record.provider.length > 256 ||
    typeof record.model !== "string" || record.model.length < 1 || record.model.length > 256 ||
    phase.length > 128 ||
    requiredNumbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !validTokenNumber(record.input_cache_hit_tokens) ||
    !validTokenNumber(record.input_cache_miss_tokens) ||
    [record.input_usd, record.output_usd, record.total_usd, record.latency_ms].some((value) => !validNumber(value)) ||
    (record.input_cache_hit_tokens ?? 0) > record.input_tokens ||
    (record.input_cache_miss_tokens ?? 0) > record.input_tokens ||
    record.total_tokens < Math.max(record.input_tokens, record.output_tokens) ||
    (record.retry_count !== undefined && (!Number.isSafeInteger(record.retry_count) || record.retry_count < 0)) ||
    (record.outcome !== undefined && record.outcome !== "success" && record.outcome !== "failed") ||
    (record.outcome === "failed" && record.error_code === undefined) ||
    !errorCodeValid ||
    JSON.stringify(record).length > 16_384
  ) {
    resumeConfigError(
      `usage.jsonl contains an invalid accounting row for phase ${String(record.phase)}.`,
      "resume.usage_invalid",
      "Restore usage.jsonl from the original run; usage accounting is append-only and cannot be guessed."
    );
  }
}

export async function persistPrunedTrace(runDir: string, pruned: ResumeTrace): Promise<void> {
  const sentinelPath = join(runDir, pruneSentinelFile);
  await writeFile(sentinelPath, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, "utf8");
  const rewrites: Array<readonly [string, unknown[]]> = [
    [runArtifactFiles.trace, pruned.events],
    [runArtifactFiles.candidates, pruned.candidates],
    [runArtifactFiles.comparisons, pruned.comparisons],
    [runArtifactFiles.scores, pruned.scores],
    [runArtifactFiles.usage, pruned.usage]
  ];
  for (const [fileName, rows] of rewrites) {
    await writeJsonlAtomic(runDir, fileName, rows);
  }
  await unlink(sentinelPath);
}

export function assertNoPruneInProgress(runDir: string): void {
  if (!existsSync(join(runDir, pruneSentinelFile))) return;
  resumeConfigError(
    "A previous trace prune did not finish; refusing to resume from a partially rewritten trace.",
    "resume.prune_in_progress",
    `Inspect ${join(runDir, pruneSentinelFile)} and the JSONL artifacts before retrying.`
  );
}

function phaseKey(phase: PhaseName, generation?: number): string {
  if ((phase === "generation_judging" || phase === "generation_mutation") && generation !== undefined) {
    return `${phase}:${generation}`;
  }
  return phase;
}

function strictPhaseKey(config: RunConfig, phase: PhaseName, generation: number | undefined): string {
  if (phase === "generation_judging" || phase === "generation_mutation") {
    if (generation === undefined || generation < 1 || generation > config.profile.t) {
      resumeConfigError(
        `${phase} marker has invalid generation ${String(generation)}.`,
        "resume.phase_marker_invalid",
        `Generation must be between 1 and ${config.profile.t}.`
      );
    }
    return phaseKey(phase, generation);
  }
  if (generation !== undefined) {
    resumeConfigError(
      `${phase} marker must not include generation ${generation}.`,
      "resume.phase_marker_invalid",
      "Only generation_judging and generation_mutation markers carry numeric generations."
    );
  }
  return phase;
}

function expectedPhaseSequence(config: RunConfig): string[] {
  const expected = ["initial_generation"];
  for (let generation = 1; generation <= config.profile.t; generation += 1) {
    expected.push(phaseKey("generation_judging", generation), phaseKey("generation_mutation", generation));
  }
  expected.push("final_judging", "finalizing");
  return expected;
}

function phaseCursorForKey(key: string | undefined): PhaseCursor {
  if (!key) return { phase: "summary" };
  const parsed = parsePhaseKey(key);
  if (!parsed) return { phase: "summary" };
  if (parsed.phase === "final_judging" || parsed.phase === "finalizing") return { phase: parsed.phase, generation: "final" };
  return parsed;
}

function completedPhaseEntries(completed: Set<string>): Array<{ phase: PhaseName; generation?: number }> {
  return [...completed]
    .map(parsePhaseKey)
    .filter((entry): entry is { phase: PhaseName; generation?: number } => entry !== undefined)
    .sort((left, right) => phaseOrder(left.phase) - phaseOrder(right.phase) || (left.generation ?? 0) - (right.generation ?? 0));
}

function parsePhaseKey(key: string): { phase: PhaseName; generation?: number } | undefined {
  const match = /^(generation_judging|generation_mutation):(\d+)$/.exec(key);
  if (match) return { phase: match[1] as PhaseName, generation: Number(match[2]) };
  if (
    key === "initial_generation" ||
    key === "generation_judging" ||
    key === "generation_mutation" ||
    key === "final_judging" ||
    key === "finalizing"
  ) {
    return { phase: key };
  }
  return undefined;
}

function phaseOrder(phase: PhaseName): number {
  switch (phase) {
    case "initial_generation":
      return 0;
    case "generation_judging":
      return 1;
    case "generation_mutation":
      return 2;
    case "final_judging":
      return 3;
    case "finalizing":
      return 4;
  }
}

function keepCandidate(candidate: Candidate, completed: Set<string>): boolean {
  if (candidate.status === "discarded") return completed.has(phaseKey("generation_mutation", candidate.generation + 1));
  if (candidate.generation === 0) return completed.has("initial_generation");
  return completed.has(phaseKey("generation_mutation", candidate.generation));
}

function keepPopulationGeneration(generation: number, completed: Set<string>): boolean {
  if (generation === 0) return completed.has("initial_generation");
  return completed.has(phaseKey("generation_mutation", generation));
}

function keepEvent(
  event: Record<string, unknown>,
  completed: Set<string>,
  candidateIds: Set<string>,
  comparisonIds: Set<string>
): boolean {
  const type = event.type;
  if (typeof type !== "string") return true;
  if (type.startsWith("candidate.")) {
    const candidateId = event.candidate_id;
    return typeof candidateId !== "string" || candidateIds.has(candidateId);
  }
  if (type.startsWith("comparison.")) {
    const comparisonId = event.comparison_id;
    return typeof comparisonId !== "string" || comparisonIds.has(comparisonId);
  }
  if (type === "phase.completed") {
    const parsed = phaseCompletedEventSchema.safeParse(event);
    return !parsed.success || completed.has(phaseKey(parsed.data.phase, parsed.data.generation));
  }
  return true;
}

function phaseKeyForComparison(comparison: Comparison): string {
  return comparison.generation === "final" ? "final_judging" : phaseKey("generation_judging", comparison.generation);
}

function phaseKeyForScore(score: BtScore): string {
  return score.generation === "final" ? "final_judging" : phaseKey("generation_judging", score.generation);
}

function usagePhaseKey(phase: string): string | undefined {
  if (phase === "gen0_initial") return "initial_generation";
  if (phase === "final_judge") return "final_judging";
  if (phase === "finalize") return "finalizing";
  const judge = /^gen(\d+)_judge$/.exec(phase);
  if (judge) return phaseKey("generation_judging", Number(judge[1]));
  const mutate = /^gen(\d+)_mutate$/.exec(phase);
  if (mutate) return phaseKey("generation_mutation", Number(mutate[1]));
  return undefined;
}

function requiredPopulationGenerations(config: RunConfig, completed: Set<string>): number[] {
  const generations: number[] = [];
  if (completed.has("initial_generation")) generations.push(0);
  for (let gen = 1; gen <= config.profile.t; gen += 1) {
    if (completed.has(phaseKey("generation_mutation", gen))) generations.push(gen);
  }
  return generations;
}

function requirePopulation(populationByGeneration: Map<number, Candidate[]>, generation: number): Candidate[] {
  const population = populationByGeneration.get(generation);
  if (!population) {
    resumeConfigError(
      `Cannot reconstruct scores without population generation ${generation}.`,
      "resume.population_missing",
      "Restore the population snapshot or start a fresh run."
    );
  }
  return population;
}

function sanityCheckScores(
  existingScores: BtScore[],
  generation: number | "final",
  population: Candidate[],
  reconstructed: BtScore[]
): void {
  const ids = new Set(population.map((candidate) => candidate.id));
  const stored = existingScores.filter((score) => score.generation === generation);
  if (stored.length !== population.length || new Set(stored.map((score) => score.candidateId)).size !== stored.length) {
    resumeConfigError(
      `scores.jsonl for generation ${generation} has ${stored.length} rows; expected one for each of ${population.length} candidates.`,
      "resume.scores_invalid",
      "Restore the complete score rows or start a fresh run."
    );
  }
  for (const score of stored) {
    if (!ids.has(score.candidateId)) {
      resumeConfigError(
        `scores.jsonl for generation ${generation} references unknown candidate ${score.candidateId}.`,
        "resume.scores_invalid",
        "Inspect the run directory for a mixed or corrupted trace."
      );
    }
  }
  const storedById = new Map(stored.map((score) => [score.candidateId, score]));
  for (const expected of reconstructed) {
    const actual = storedById.get(expected.candidateId);
    if (!actual || !scoresEqual(actual, expected)) {
      resumeConfigError(
        `scores.jsonl for generation ${generation} does not match recomputed Bradley-Terry scores for ${expected.candidateId}.`,
        "resume.scores_mismatch",
        "Restore scores.jsonl and comparisons.jsonl from the same run."
      );
    }
  }
}

function validateComparisons(
  config: RunConfig,
  generation: number | "final",
  population: Candidate[],
  comparisons: Comparison[],
  runId?: string
): void {
  const degree = generation === "final" ? config.profile.m : config.profile.k;
  const expectedCount = (population.length * degree) / 2;
  if (comparisons.length !== expectedCount) {
    resumeConfigError(
      `comparisons.jsonl for generation ${generation} has ${comparisons.length} rows; expected ${expectedCount}.`,
      "resume.comparisons_invalid",
      "Restore the complete comparison rows or replay from the previous phase boundary."
    );
  }
  const ids = new Set(population.map((candidate) => candidate.id));
  const comparisonIds = new Set<string>();
  const pairs = new Set<string>();
  const critiqueChars = new Map(population.map((candidate) => [candidate.id, 0]));
  for (const comparison of comparisons) {
    assertComparisonShape(comparison, runId);
    const pair = [comparison.candidateAId, comparison.candidateBId].sort().join("\u0000");
    if (
      comparison.generation !== generation ||
      !comparison.id ||
      comparisonIds.has(comparison.id) ||
      !ids.has(comparison.candidateAId) ||
      !ids.has(comparison.candidateBId) ||
      comparison.candidateAId === comparison.candidateBId ||
      pairs.has(pair) ||
      comparison.presentedAOriginalId !== comparison.candidateAId ||
      comparison.presentedBOriginalId !== comparison.candidateBId ||
      !["A", "B", "tie"].includes(comparison.winner)
    ) {
      resumeConfigError(
        `comparisons.jsonl contains an invalid or duplicate comparison ${comparison.id || "without an ID"} for generation ${generation}.`,
        "resume.comparisons_invalid",
        "Restore comparisons.jsonl from the original run."
      );
    }
    comparisonIds.add(comparison.id);
    pairs.add(pair);
    critiqueChars.set(
      comparison.candidateAId,
      (critiqueChars.get(comparison.candidateAId) ?? 0) + comparison.critiqueForA.length
    );
    critiqueChars.set(
      comparison.candidateBId,
      (critiqueChars.get(comparison.candidateBId) ?? 0) + comparison.critiqueForB.length
    );
  }
  if ([...critiqueChars.values()].some((length) => length > 16_000)) {
    resumeConfigError(
      `comparisons.jsonl for generation ${generation} exceeds the 16000-character per-candidate critique bound.`,
      "resume.comparison_field_too_large",
      "Restore bounded comparison feedback from the original run."
    );
  }
  const phase = generation === "final" ? "final_judging" : "generation_judging";
  const rng = createRng(hashPhaseSeed(`${config.seed}:${phase}:${generation === "final" ? "" : generation}`));
  const expectedPairs = new Set(
    makeKRegularPairs(
      population.map((candidate) => candidate.id),
      degree,
      rng
    ).map((pair) => [pair.a, pair.b].sort().join("\u0000"))
  );
  if (!isDeepStrictEqual([...pairs].sort(), [...expectedPairs].sort())) {
    resumeConfigError(
      `comparisons.jsonl for generation ${generation} does not match the deterministic seeded pair schedule.`,
      "resume.comparison_schedule_mismatch",
      "Restore comparisons.jsonl from the original run."
    );
  }
}

function assertComparisonShape(comparison: Comparison, runId?: string): void {
  if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) {
    resumeConfigError(
      "comparisons.jsonl contains a non-object completed comparison row.",
      "resume.comparison_row_invalid",
      "Restore comparison rows from the original run."
    );
  }
  const boundedString = (value: unknown, max: number, allowEmpty = true): value is string =>
    typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max;
  const metadataValid =
    comparison.metadata === undefined ||
    (comparison.metadata !== null &&
      typeof comparison.metadata === "object" &&
      !Array.isArray(comparison.metadata) &&
      JSON.stringify(comparison.metadata).length <= 1_048_576);
  if (
    !boundedString(comparison.id, 512, false) ||
    !boundedString(comparison.runId, 128, false) ||
    (runId !== undefined && comparison.runId !== runId) ||
    !boundedString(comparison.candidateAId, 512, false) ||
    !boundedString(comparison.candidateBId, 512, false) ||
    !boundedString(comparison.presentedAOriginalId, 512, false) ||
    !boundedString(comparison.presentedBOriginalId, 512, false) ||
    !boundedString(comparison.critiqueForA, 16_000) ||
    !boundedString(comparison.critiqueForB, 16_000) ||
    !boundedString(comparison.selectionReason, 16_000) ||
    (comparison.model !== undefined && !boundedString(comparison.model, 256, false)) ||
    (comparison.provider !== undefined && !boundedString(comparison.provider, 256, false)) ||
    (comparison.confidence !== undefined &&
      (typeof comparison.confidence !== "number" ||
        !Number.isFinite(comparison.confidence) ||
        comparison.confidence < 0 ||
        comparison.confidence > 1)) ||
    !metadataValid ||
    JSON.stringify(comparison).length > 2_097_152
  ) {
    resumeConfigError(
      "comparisons.jsonl contains a malformed or oversized completed comparison row.",
      "resume.comparison_row_invalid",
      "Restore bounded comparison rows from the original run."
    );
  }
}

function hashPhaseSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assertCandidateShape(candidate: Candidate): void {
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    !candidate.id ||
    !Number.isInteger(candidate.generation) ||
    typeof candidate.content !== "string" ||
    !candidate.metadata ||
    typeof candidate.metadata.createdAt !== "string"
  ) {
    resumeConfigError(
      "candidates.jsonl or a population snapshot contains a structurally invalid candidate.",
      "resume.candidates_invalid",
      "Restore the candidate artifacts from the original run."
    );
  }
}

function scoresEqual(left: BtScore, right: BtScore): boolean {
  const numericKeys = ["score", "rank", "wins", "losses", "ties", "comparisons"] as const;
  return (
    left.candidateId === right.candidateId &&
    left.generation === right.generation &&
    left.tieGroup === right.tieGroup &&
    left.tieBreakerRank === right.tieBreakerRank &&
    numericKeys.every((key) => Number.isFinite(left[key]) && Math.abs(left[key] - right[key]) < 1e-12)
  );
}

async function readJson<T>(runDir: string, fileName: string): Promise<T> {
  try {
    return JSON.parse(await readFile(join(runDir, fileName), "utf8")) as T;
  } catch (error) {
    resumeConfigError(
      `Could not read ${fileName}: ${(error as Error).message}`,
      "resume.trace_read_failed",
      "Inspect the run directory and file permissions."
    );
  }
}

async function readJsonl<T>(runDir: string, fileName: string): Promise<T[]> {
  const path = join(runDir, fileName);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      out.push(JSON.parse(lines[i]) as T);
    } catch (err) {
      if (i === lines.length - 1) {
        break;
      }
      throw resumeConfigError(
        `Corrupted ${fileName} JSONL at line ${i + 1}: ${(err as Error).message}`,
        "resume.corrupted_trace",
        `Inspect ${path}; mid-file parse failures indicate non-recoverable trace corruption.`
      );
    }
  }
  return out;
}

async function writeJsonlAtomic(runDir: string, fileName: string, rows: unknown[]): Promise<void> {
  const tempFile = join(runDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  const body = rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeFile(tempFile, body, "utf8");
  try {
    await rename(tempFile, join(runDir, fileName));
  } catch (error) {
    await unlink(tempFile).catch(() => undefined);
    throw error;
  }
}
