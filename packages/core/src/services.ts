import { z } from "zod";
import { fitBradleyTerry } from "./bradleyTerry.js";
import { ConfigError } from "./errors.js";
import { parseJsonObject } from "./json.js";
import { makeKRegularPairs, type Pair } from "./pairScheduler.js";
import { runLimitedPhase } from "./phaseRunner.js";
import { comparePrompt, mutatePrompt } from "./prompts.js";
import { createRng, type Rng } from "./rng.js";
import type { BtScore, Candidate, Comparison, ModelDriver, ModelTextResult, PromptOverrides, RunConfig } from "./schemas.js";

export type CandidateInput = string | { id?: string; content: string };

export interface RankCandidatesOptions {
  task: string;
  rubric?: string;
  candidates: CandidateInput[];
  driver: ModelDriver;
  judgeModel: string;
  runId?: string;
  generation?: number | "final";
  temperature?: number;
  lambda?: number;
  concurrency?: number;
  seed?: number;
  mode?: "all-pairs" | "k-regular";
  k?: number;
  maxCalls?: number;
  rank?: RunConfig["rank"];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  promptStyle?: RunConfig["promptStyle"];
  promptOverrides?: Pick<PromptOverrides, "compare">;
}

export interface RankCandidatesResult {
  candidates: Candidate[];
  comparisons: Comparison[];
  scores: BtScore[];
}

export interface MutateCandidateOptions {
  task: string;
  rubric?: string;
  candidate: CandidateInput;
  critique: string;
  driver: ModelDriver;
  mutatorModel: string;
  temperature?: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  promptStyle?: RunConfig["promptStyle"];
  promptOverrides?: Pick<PromptOverrides, "mutate">;
}

export interface MutateCandidateResult {
  mutated: string;
  model?: string;
  provider?: string;
  usage?: ModelTextResult["usage"];
}

const compareOutputSchema = z.object({
  winner: z.enum(["A", "B", "tie"]),
  confidence: z.number().min(0).max(1).optional(),
  critique_for_A: z.string().optional(),
  critique_for_B: z.string().optional(),
  feedback_a: z.string().optional(),
  feedback_b: z.string().optional(),
  selection_reason: z.string().default("")
});

export async function rankCandidates(options: RankCandidatesOptions): Promise<RankCandidatesResult> {
  const candidates = normalizeCandidates(options.candidates);
  assertUniqueCandidateIds(candidates);
  if (candidates.length < 2) {
    throw new ConfigError("Ranking requires at least two candidates.", {
      code: "rank.too_few_candidates",
      retryable: false,
      fix: "Supply at least two candidates with unique IDs."
    });
  }
  const rankConfig = {
    mode: options.mode ?? options.rank?.mode,
    k: options.k ?? options.rank?.k,
    seed: options.seed ?? options.rank?.seed ?? 0,
    maxCalls: options.maxCalls ?? options.rank?.maxCalls
  };
  const pairSpecs = rankPairSpecs(candidates, rankConfig);
  const presentationBalance = new Map(candidates.map((candidate) => [candidate.id, 0]));
  const rng = createRng(rankConfig.seed);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  function* jobs(): Generator<(signal: AbortSignal) => Promise<Comparison>> {
    for (const [pairIndex, pair] of pairSpecs.entries()) {
      const left = byId.get(pair.a)!;
      const right = byId.get(pair.b)!;
      const [candidateA, candidateB] = balancedPresentation(left, right, presentationBalance, rng);
      yield async (signal) => {
        const prompt = comparePrompt(options.task, candidateA, candidateB, options.rubric, options.promptStyle, options.promptOverrides?.compare);
        const result = await options.driver.compare({
          task: options.task,
          rubric: options.rubric,
          model: options.judgeModel,
          temperature: options.temperature ?? 0,
          candidateA,
          candidateB,
          prompt,
          signal,
          maxOutputTokens: options.maxOutputTokens ?? 1_024
        });
        let parsed: z.infer<typeof compareOutputSchema> | undefined;
        try {
          parsed = compareOutputSchema.parse(parseJsonObject(result.text));
        } catch {
          parsed = undefined;
        }
        if (!parsed) {
          throw new ConfigError(
            `Judge produced invalid-JSON output for rank comparison rank-${pairIndex}. Refusing to synthesize a tie and pollute the ranking.`,
            {
              code: "judge.persistent_invalid_json",
              retryable: false,
              fix: "The judge model is producing unparseable output. Inspect the raw response, switch judge models, or use a different judge that returns strict JSON."
            }
          );
        }
        return {
          id: `rank-${pairIndex}`,
          runId: options.runId ?? "rank",
          generation: options.generation ?? "final",
          candidateAId: candidateA.id,
          candidateBId: candidateB.id,
          presentedAOriginalId: candidateA.id,
          presentedBOriginalId: candidateB.id,
          winner: parsed.winner,
          confidence: parsed.confidence,
          critiqueForA: parsed.feedback_a ?? parsed.critique_for_A ?? "",
          critiqueForB: parsed.feedback_b ?? parsed.critique_for_B ?? "",
          selectionReason: parsed.selection_reason ?? "",
          model: result.model,
          provider: result.provider,
          metadata: compactMetadata({
            model_call_count: 1,
            provider_retry_count: result.retryCount || undefined
          })
        };
      };
    }
  }

  const comparisons = await runLimitedPhase(jobs(), options.concurrency ?? 1, { signal: options.signal });
  return {
    candidates,
    comparisons,
    scores: fitBradleyTerry(candidates, comparisons, options.lambda)
  };
}

export async function mutateCandidate(options: MutateCandidateOptions): Promise<MutateCandidateResult> {
  const candidate = normalizeCandidate(options.candidate, 0);
  const result = await options.driver.mutate({
    task: options.task,
    rubric: options.rubric,
    model: options.mutatorModel,
    temperature: options.temperature ?? 0.6,
    candidate,
    critique: options.critique,
    prompt: mutatePrompt(options.task, candidate, options.critique, options.rubric, options.promptStyle, options.promptOverrides?.mutate),
    signal: options.signal,
    maxOutputTokens: options.maxOutputTokens ?? 4_096
  });
  return { mutated: result.text, model: result.model, provider: result.provider, usage: result.usage };
}

function rankPairSpecs(
  candidates: Candidate[],
  config: { mode?: "all-pairs" | "k-regular"; k?: number; seed: number; maxCalls?: number }
): Pair[] {
  const allPairCount = (candidates.length * (candidates.length - 1)) / 2;
  let mode = config.mode;
  if (!mode) {
    if (allPairCount <= 100 || (config.maxCalls !== undefined && config.maxCalls >= allPairCount)) mode = "all-pairs";
    else if (config.k !== undefined) mode = "k-regular";
    else {
      throw new ConfigError(
        `Ranking ${candidates.length} candidates requires ${allPairCount} all-pairs calls, above the default limit of 100.`,
        {
          code: "rank.explicit_schedule_required",
          retryable: false,
          fix: "Set maxCalls high enough for all-pairs, or select k-regular mode with an explicit k."
        }
      );
    }
  }
  let pairs: Pair[];
  if (mode === "all-pairs") {
    if (allPairCount > 100 && (config.maxCalls === undefined || config.maxCalls < allPairCount)) {
      throw new ConfigError(`All-pairs ranking requires explicit maxCalls >= ${allPairCount}.`, {
        code: "rank.max_calls_required",
        retryable: false,
        fix: "Raise maxCalls or use k-regular ranking."
      });
    }
    pairs = [];
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        pairs.push({ a: candidates[left].id, b: candidates[right].id });
      }
    }
    pairs = createRng(config.seed).shuffle(pairs);
  } else {
    if (config.k === undefined) {
      throw new ConfigError("k-regular ranking requires an explicit k.", {
        code: "rank.k_required",
        retryable: false
      });
    }
    pairs = makeKRegularPairs(
      candidates.map((candidate) => candidate.id),
      config.k,
      createRng(config.seed)
    );
  }
  if (config.maxCalls !== undefined && pairs.length > config.maxCalls) {
    throw new ConfigError(`Ranking schedule requires ${pairs.length} calls, exceeding maxCalls ${config.maxCalls}.`, {
      code: "rank.max_calls_exceeded",
      retryable: false,
      fix: "Raise maxCalls or reduce k."
    });
  }
  return pairs;
}

export function normalizeCandidates(candidates: CandidateInput[]): Candidate[] {
  return candidates.map((candidate, index) => normalizeCandidate(candidate, index));
}

function assertUniqueCandidateIds(candidates: Candidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.id.trim()) {
      throw new ConfigError("Candidate IDs cannot be empty.", { code: "rank.candidate_id_invalid", retryable: false });
    }
    if (seen.has(candidate.id)) {
      throw new ConfigError(`Candidate ID ${candidate.id} is duplicated; ranking would collapse distinct candidates.`, {
        code: "rank.duplicate_candidate_id",
        retryable: false,
        fix: "Give every candidate a unique ID."
      });
    }
    seen.add(candidate.id);
  }
}

function balancedPresentation(
  left: Candidate,
  right: Candidate,
  balance: Map<string, number>,
  rng: Rng
): [Candidate, Candidate] {
  const leftBalance = balance.get(left.id) ?? 0;
  const rightBalance = balance.get(right.id) ?? 0;
  const normalCost = Math.abs(leftBalance + 1) + Math.abs(rightBalance - 1);
  const swappedCost = Math.abs(leftBalance - 1) + Math.abs(rightBalance + 1);
  const swap = swappedCost < normalCost || (swappedCost === normalCost && rng.bool());
  const candidateA = swap ? right : left;
  const candidateB = swap ? left : right;
  balance.set(candidateA.id, (balance.get(candidateA.id) ?? 0) + 1);
  balance.set(candidateB.id, (balance.get(candidateB.id) ?? 0) - 1);
  return [candidateA, candidateB];
}

function normalizeCandidate(candidate: CandidateInput, index: number): Candidate {
  const value = typeof candidate === "string" ? { content: candidate } : candidate;
  return {
    id: value.id ?? `candidate-${index + 1}`,
    generation: 0,
    kind: "user-supplied",
    content: value.content,
    metadata: { createdAt: new Date().toISOString() }
  };
}

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const compacted = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
