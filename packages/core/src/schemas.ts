import { z } from "zod";

export const candidateStatusSchema = z.enum(["generated", "mutated", "elite", "discarded"]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

export const profileSchema = z.object({
  n: z.number().int().min(2),
  k: z.number().int().min(1),
  t: z.number().int().min(0),
  m: z.number().int().min(1),
  lambda: z.number().min(0).default(0.01),
  sampleTemperature: z.number().min(0).default(0.8),
  mutateTemperature: z.number().min(0).default(0.6),
  judgeTemperature: z.number().min(0).default(0)
});
export type Profile = z.infer<typeof profileSchema>;

export const builtInProfiles = {
  quick: {
    n: 4,
    k: 2,
    t: 1,
    m: 2,
    lambda: 0.01,
    sampleTemperature: 1,
    mutateTemperature: 1,
    judgeTemperature: 0
  },
  balanced: {
    n: 8,
    k: 3,
    t: 2,
    m: 4,
    lambda: 0.01,
    sampleTemperature: 1,
    mutateTemperature: 1,
    judgeTemperature: 0
  },
  paper: {
    n: 20,
    k: 4,
    t: 3,
    m: 10,
    lambda: 0.01,
    sampleTemperature: 1,
    mutateTemperature: 1,
    judgeTemperature: 0
  }
} as const satisfies Record<string, Profile>;

export type BuiltInProfileName = keyof typeof builtInProfiles;

export interface Candidate {
  id: string;
  generation: number;
  parentId?: string;
  kind: "initial" | "mutation" | "elite-copy" | "user-supplied";
  content: string;
  status?: CandidateStatus;
  metadata: {
    model?: string;
    provider?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
    createdAt: string;
    [key: string]: unknown;
  };
}

export interface Comparison {
  id: string;
  runId: string;
  generation: number | "final";
  candidateAId: string;
  candidateBId: string;
  presentedAOriginalId: string;
  presentedBOriginalId: string;
  winner: "A" | "B" | "tie";
  confidence?: number;
  critiqueForA: string;
  critiqueForB: string;
  selectionReason: string;
  rawOutput?: unknown;
  model?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface BtScore {
  candidateId: string;
  generation: number | "final";
  score: number;
  rank: number;
  tieGroup?: number;
  tieBreakerRank?: number;
  wins: number;
  losses: number;
  ties: number;
  comparisons: number;
}

const promptOverrideSchema = z.object({
  system: z.string().optional(),
  user: z.string().optional()
});

const promptOverridesSchema = z.object({
  generate: promptOverrideSchema.optional(),
  compare: promptOverrideSchema.optional(),
  mutate: promptOverrideSchema.optional(),
  finalize: promptOverrideSchema.optional()
});

export type PromptOverride = z.infer<typeof promptOverrideSchema>;
export type PromptOverrides = z.infer<typeof promptOverridesSchema>;

const providerReplayRoleSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string().min(1),
  supportsJsonMode: z.boolean().optional()
});

const samplingPreferencesSchema = z.object({
  modelHints: z.array(z.string().min(1)).optional(),
  costPriority: z.number().min(0).max(1).optional(),
  speedPriority: z.number().min(0).max(1).optional(),
  intelligencePriority: z.number().min(0).max(1).optional()
});

const providerReplaySchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  supportsJsonMode: z.boolean().optional(),
  routeFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  samplingPreferences: samplingPreferencesSchema.optional(),
  models: z.object({
    generator: z.string().min(1),
    mutator: z.string().min(1),
    judge: z.string().min(1),
    finalizer: z.string().optional()
  }),
  roleProviders: z
    .object({
      generator: providerReplayRoleSchema.optional(),
      mutator: providerReplayRoleSchema.optional(),
      judge: providerReplayRoleSchema.optional(),
      finalizer: providerReplayRoleSchema.optional()
    })
    .strict()
    .optional()
});

export const runIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Run IDs may contain only letters, digits, dot, underscore, and hyphen.")
  .refine((value) => value !== "." && value !== "..", "Run ID cannot be a path segment.");

export const runConfigSchema = z.object({
  version: z.string().optional(),
  runId: runIdSchema.optional(),
  task: z.string().min(1),
  rubric: z.string().optional(),
  promptStyle: z.enum(["general", "paper-programming"]).default("general"),
  promptOverrides: promptOverridesSchema.optional(),
  profile: profileSchema,
  runDir: z.string().min(1),
  seed: z.number().int(),
  provider: z.string().min(1),
  providerReplay: providerReplaySchema.optional(),
  generatorModel: z.string().min(1),
  mutatorModel: z.string().min(1),
  judgeModel: z.string().min(1),
  finalizerModel: z.string().optional(),
  concurrency: z.object({
    generate: z.number().int().min(1),
    judge: z.number().int().min(1),
    mutate: z.number().int().min(1)
  }),
  retry: z.object({
    httpRetries: z.number().int().min(0).default(12),
    invalidJsonRetries: z.number().int().min(0).default(1),
    requestTimeoutMs: z.number().int().min(1).optional()
  }),
  budget: z
    .object({
      maxCalls: z.number().int().min(1).optional(),
      maxInputTokens: z.number().int().min(1).optional(),
      maxOutputTokens: z.number().int().min(1).optional(),
      maxUsd: z.number().min(0).optional(),
      prices: z
        .array(
          z
            .object({
              provider: z.string().min(1),
              model: z.string().min(1),
              inputUsdPerMillion: z.number().min(0).optional(),
              inputCacheHitUsdPerMillion: z.number().min(0).optional(),
              inputCacheMissUsdPerMillion: z.number().min(0).optional(),
              outputUsdPerMillion: z.number().min(0).optional(),
              longContextThresholdTokens: z.number().int().min(1).optional(),
              inputUsdPerMillionLong: z.number().min(0).optional(),
              outputUsdPerMillionLong: z.number().min(0).optional()
            })
            .refine(
              (price) => {
                const hasAnyLong =
                  price.longContextThresholdTokens !== undefined ||
                  price.inputUsdPerMillionLong !== undefined ||
                  price.outputUsdPerMillionLong !== undefined;
                if (!hasAnyLong) return true;
                return (
                  price.longContextThresholdTokens !== undefined &&
                  price.inputUsdPerMillion !== undefined &&
                  price.outputUsdPerMillion !== undefined &&
                  price.inputUsdPerMillionLong !== undefined &&
                  price.outputUsdPerMillionLong !== undefined
                );
              },
              { message: "Long-context pricing requires longContextThresholdTokens and the full flat/long input/output rate set together." }
            )
        )
        .optional()
    })
    .optional(),
  output: z
    .object({
      includeRawModelOutputs: z.boolean().default(false),
      includePrompts: z.boolean().default(false)
    })
    .default({ includeRawModelOutputs: false, includePrompts: false })
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export const phaseNameSchema = z.enum([
  "initial_generation",
  "generation_judging",
  "generation_mutation",
  "final_judging",
  "finalizing"
]);
export type PhaseName = z.infer<typeof phaseNameSchema>;

export const phaseCompletedEventSchema = z.object({
  type: z.literal("phase.completed"),
  phase: phaseNameSchema,
  generation: z.number().int().optional(),
  at: z.string().datetime()
});
export type PhaseCompletedEvent = z.infer<typeof phaseCompletedEventSchema>;

export interface ModelTextResult {
  text: string;
  model?: string;
  provider?: string;
  usage?: {
    inputTokens?: number;
    inputCacheHitTokens?: number;
    inputCacheMissTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  latencyMs?: number;
  retryCount?: number;
  raw?: unknown;
}

export interface GenerateInput {
  task: string;
  rubric?: string;
  model: string;
  temperature: number;
  candidateIndex?: number;
  prompt?: PromptMessages;
}

export interface CompareInput {
  task: string;
  rubric?: string;
  model: string;
  temperature: number;
  candidateA: Candidate;
  candidateB: Candidate;
  prompt?: PromptMessages;
}

export interface MutateInput {
  task: string;
  rubric?: string;
  model: string;
  temperature: number;
  candidate: Candidate;
  critique: string;
  prompt?: PromptMessages;
}

export interface FinalizeInput {
  task: string;
  rubric?: string;
  model: string;
  candidate: Candidate;
  prompt?: PromptMessages;
}

export interface PromptMessages {
  system: string;
  user: string;
}

export interface ModelDriver {
  generate(input: GenerateInput): Promise<ModelTextResult>;
  compare(input: CompareInput): Promise<ModelTextResult>;
  mutate(input: MutateInput): Promise<ModelTextResult>;
  finalize?(input: FinalizeInput): Promise<ModelTextResult>;
}

export interface RunResult {
  runId: string;
  runDir: string;
  winner: Candidate;
  finalAnswer: string;
  finalScores: BtScore[];
  calls: number;
}
