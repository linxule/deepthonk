import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runArtifactFiles } from "./artifacts.js";
import { fitBradleyTerry } from "./bradleyTerry.js";
import { BudgetTracker } from "./budgetTracker.js";
import { ConfigError } from "./errors.js";
import type { RunStatus, UsageRecord } from "./lifecycle.js";
import type { BtScore, Candidate, Comparison, PhaseName, RunConfig } from "./schemas.js";
import { phaseCompletedEventSchema } from "./schemas.js";

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
  const completed = new Set<string>();
  for (const event of events) {
    const parsed = phaseCompletedEventSchema.safeParse(event);
    if (!parsed.success) continue;
    completed.add(phaseKey(parsed.data.phase, parsed.data.generation));
  }

  if (!completed.has("initial_generation")) {
    return { completed, nextPhase: { phase: "initial_generation" } };
  }
  for (let gen = 1; gen <= config.profile.t; gen += 1) {
    if (!completed.has(phaseKey("generation_judging", gen))) {
      return { completed, nextPhase: { phase: "generation_judging", generation: gen } };
    }
    if (!completed.has(phaseKey("generation_mutation", gen))) {
      return { completed, nextPhase: { phase: "generation_mutation", generation: gen } };
    }
  }
  if (!completed.has("final_judging")) return { completed, nextPhase: { phase: "final_judging", generation: "final" } };
  if (!completed.has("finalizing")) return { completed, nextPhase: { phase: "finalizing", generation: "final" } };
  return { completed, nextPhase: { phase: "summary" } };
}

export function resumeConfigError(message: string, code: string, fix?: string): never {
  throw new ConfigError(message, { code, retryable: false, fix });
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
  return {
    events: trace.events,
    candidates: trace.candidates.filter((candidate) => keepCandidate(candidate, plan.completed)),
    comparisons: trace.comparisons.filter((comparison) => plan.completed.has(phaseKeyForComparison(comparison))),
    scores: trace.scores.filter((score) => plan.completed.has(phaseKeyForScore(score))),
    populations: new Map([...trace.populations].filter(([generation]) => keepPopulationGeneration(generation, plan.completed))),
    usage: trace.usage.filter((record) => {
      const key = usagePhaseKey(record.phase);
      return key !== undefined && plan.completed.has(key);
    })
  };
}

export function buildPopulationMap(
  config: RunConfig,
  populations: Map<number, Candidate[]>,
  candidates: Candidate[],
  plan: InternalResumePlan
): Map<number, Candidate[]> {
  const byId = new Set(candidates.filter((candidate) => candidate.status !== "discarded").map((candidate) => candidate.id));
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
    for (const candidate of population) {
      if (!byId.has(candidate.id)) {
        resumeConfigError(
          `population-${generation}.json references missing candidate ${candidate.id}.`,
          "resume.population_invalid",
          "Restore candidates.jsonl or start a fresh run."
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
  plan: InternalResumePlan
): Map<number | "final", BtScore[]> {
  const scoresByGeneration = new Map<number | "final", BtScore[]>();
  for (let gen = 1; gen <= config.profile.t; gen += 1) {
    if (!plan.completed.has(phaseKey("generation_judging", gen))) continue;
    const population = requirePopulation(populationByGeneration, gen - 1);
    sanityCheckScores(existingScores, gen, population);
    scoresByGeneration.set(
      gen,
      fitBradleyTerry(population, comparisonsByGeneration.get(gen) ?? [], config.profile.lambda, gen)
    );
  }
  if (plan.completed.has("final_judging")) {
    const population = requirePopulation(populationByGeneration, config.profile.t);
    sanityCheckScores(existingScores, "final", population);
    scoresByGeneration.set(
      "final",
      fitBradleyTerry(population, comparisonsByGeneration.get("final") ?? [], config.profile.lambda, "final")
    );
  }
  return scoresByGeneration;
}

export function replayBudgetUsage(config: RunConfig, usage: UsageRecord[]): BudgetTracker {
  const tracker = new BudgetTracker(config);
  let hasUsd = false;
  for (const record of usage) {
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

export async function persistPrunedTrace(runDir: string, pruned: ResumeTrace): Promise<void> {
  await Promise.all([
    writeJsonlAtomic(runDir, runArtifactFiles.candidates, pruned.candidates),
    writeJsonlAtomic(runDir, runArtifactFiles.comparisons, pruned.comparisons),
    writeJsonlAtomic(runDir, runArtifactFiles.scores, pruned.scores),
    writeJsonlAtomic(runDir, runArtifactFiles.usage, pruned.usage)
  ]);
}

function phaseKey(phase: PhaseName, generation?: number): string {
  if ((phase === "generation_judging" || phase === "generation_mutation") && generation !== undefined) {
    return `${phase}:${generation}`;
  }
  return phase;
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

function sanityCheckScores(existingScores: BtScore[], generation: number | "final", population: Candidate[]): void {
  const ids = new Set(population.map((candidate) => candidate.id));
  for (const score of existingScores) {
    if (score.generation !== generation) continue;
    if (!ids.has(score.candidateId)) {
      resumeConfigError(
        `scores.jsonl for generation ${generation} references unknown candidate ${score.candidateId}.`,
        "resume.scores_invalid",
        "Inspect the run directory for a mixed or corrupted trace."
      );
    }
  }
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
  let text: string;
  try {
    text = await readFile(join(runDir, fileName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    resumeConfigError(
      `Could not read ${fileName}: ${(error as Error).message}`,
      "resume.trace_read_failed",
      "Inspect the run directory and file permissions."
    );
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        resumeConfigError(
          `Could not parse ${fileName} line ${index + 1}: ${(error as Error).message}`,
          "resume.trace_parse_failed",
          "Inspect the run directory for a truncated JSONL write."
        );
      }
    });
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
