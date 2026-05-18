import pLimit from "p-limit";
import { z } from "zod";
import { fitBradleyTerry } from "./bradleyTerry.js";
import { parseJsonObject } from "./json.js";
import { comparePrompt, mutatePrompt } from "./prompts.js";
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
  const comparisons: Comparison[] = [];
  const limit = pLimit(options.concurrency ?? 1);
  const tasks: Array<Promise<Comparison>> = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      tasks.push(
        limit(async () => {
          const candidateA = candidates[i];
          const candidateB = candidates[j];
          const prompt = comparePrompt(options.task, candidateA, candidateB, options.rubric, options.promptStyle, options.promptOverrides?.compare);
          const result = await options.driver.compare({
            task: options.task,
            rubric: options.rubric,
            model: options.judgeModel,
            temperature: options.temperature ?? 0,
            candidateA,
            candidateB,
            prompt
          });
          let parsed: z.infer<typeof compareOutputSchema> | undefined;
          try {
            parsed = compareOutputSchema.parse(parseJsonObject(result.text));
          } catch {
            parsed = undefined;
          }
          const comparison: Comparison = {
            id: `rank-${i}-${j}`,
            runId: options.runId ?? "rank",
            generation: options.generation ?? "final",
            candidateAId: candidateA.id,
            candidateBId: candidateB.id,
            presentedAOriginalId: candidateA.id,
            presentedBOriginalId: candidateB.id,
            winner: parsed?.winner ?? "tie",
            confidence: parsed?.confidence,
            critiqueForA: parsed?.feedback_a ?? parsed?.critique_for_A ?? (parsed ? "" : "Invalid comparison JSON; recorded as tie."),
            critiqueForB: parsed?.feedback_b ?? parsed?.critique_for_B ?? (parsed ? "" : "Invalid comparison JSON; recorded as tie."),
            selectionReason: parsed?.selection_reason ?? "invalid_json_tie",
            model: result.model,
            provider: result.provider,
            metadata: compactMetadata({
              invalid_json_tie: parsed ? undefined : true,
              model_call_count: 1,
              provider_retry_count: result.retryCount || undefined
            })
          };
          return comparison;
        })
      );
    }
  }

  comparisons.push(...(await Promise.all(tasks)));
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
    prompt: mutatePrompt(options.task, candidate, options.critique, options.rubric, options.promptStyle, options.promptOverrides?.mutate)
  });
  return { mutated: result.text, model: result.model, provider: result.provider, usage: result.usage };
}

export function normalizeCandidates(candidates: CandidateInput[]): Candidate[] {
  return candidates.map((candidate, index) => normalizeCandidate(candidate, index));
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
