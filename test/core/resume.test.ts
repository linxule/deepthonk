import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtInProfiles,
  resumeDeepThonk,
  runDeepThonk,
  type CompareInput,
  type FinalizeInput,
  type GenerateInput,
  type ModelDriver,
  type ModelTextResult,
  type MutateInput,
  type RunConfig,
  type RunResult
} from "@deepthonk/core";
import { FakeDriver } from "@deepthonk/providers";
import { buildResumePlan, readResumeTrace } from "../../packages/core/src/resume.js";

describe("resume replay", () => {
  it("ignores a crash-truncated final JSONL row when reading resume traces", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-jsonl-"));
    const candidate = candidateRow("kept_candidate", 0);
    await writeFile(join(runDir, "candidates.jsonl"), `${JSON.stringify(candidate)}\n{"id":"truncated"\n`, "utf8");

    const trace = await readResumeTrace(runDir);

    expect(trace.candidates).toEqual([candidate]);
  });

  it("detects a completed phase plan and refuses to resume an already complete run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-complete-"));
    const config = quickConfig(runDir);

    await runDeepThonk(config, new FakeDriver());
    const trace = await readResumeTrace(runDir);
    const plan = buildResumePlan(config, trace.events);

    expect(plan.nextPhase).toEqual({ phase: "summary" });
    expect([...plan.completed].sort()).toEqual([
      "final_judging",
      "finalizing",
      "generation_judging:1",
      "generation_mutation:1",
      "initial_generation"
    ]);
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.already_complete" });
  });

  it("prunes a partial generation judging phase and completes replay", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-judge-"));
    const config = quickConfig(runDir);

    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const partialComparisons = (await readJsonl<{ generation: number | "final" }>(join(runDir, "comparisons.jsonl"))).filter(
      (comparison) => comparison.generation === 1
    );
    expect(partialComparisons.length).toBeGreaterThan(0);
    expect(partialComparisons.length).toBeLessThan(4);

    const result = expectRunResult(await resumeDeepThonk(runDir, new FakeDriver()));
    const resumedComparisons = (await readJsonl<{ generation: number | "final" }>(join(runDir, "comparisons.jsonl"))).filter(
      (comparison) => comparison.generation === 1
    );
    expect(resumedComparisons).toHaveLength(4);
    expect(result.calls).toBe(15);
  });

  it("drops incomplete generation candidates from a partial mutation phase", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-mutate-"));
    const config = quickConfig(runDir);

    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("mutate", 1))).rejects.toThrow(/Injected mutate failure/);
    const partialGenerationOne = (await readJsonl<{ generation: number; status?: string }>(join(runDir, "candidates.jsonl"))).filter(
      (candidate) => candidate.generation === 1 && candidate.status !== "discarded"
    );
    expect(partialGenerationOne.length).toBeGreaterThan(0);
    expect(partialGenerationOne.length).toBeLessThan(4);

    const result = expectRunResult(await resumeDeepThonk(runDir, new FakeDriver()));
    const resumedGenerationOne = (await readJsonl<{ generation: number; status?: string }>(join(runDir, "candidates.jsonl"))).filter(
      (candidate) => candidate.generation === 1 && candidate.status !== "discarded"
    );
    expect(resumedGenerationOne).toHaveLength(4);
    expect(result.calls).toBe(15);
  });

  it("refuses to resume while a prune sentinel is present", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-prune-sentinel-"));
    await writeStoredConfig(runDir, quickConfig(runDir));
    await writeFile(join(runDir, ".prune-in-progress"), "stale prune\n", "utf8");

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.prune_in_progress" });
  });

  it("prunes candidate and comparison events for dropped trace rows", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-events-"));
    const config = quickConfig(runDir);
    const staleCandidateId = "stale_candidate_for_prune";
    const staleComparisonId = "stale_comparison_for_prune";

    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("mutate", 1))).rejects.toThrow(/Injected mutate failure/);
    await appendJsonl(join(runDir, "candidates.jsonl"), candidateRow(staleCandidateId, 2));
    await appendJsonl(join(runDir, "comparisons.jsonl"), comparisonRow(staleComparisonId));
    await appendJsonl(join(runDir, "events.jsonl"), { type: "candidate.mutated", candidate_id: staleCandidateId });
    await appendJsonl(join(runDir, "events.jsonl"), { type: "comparison.completed", comparison_id: staleComparisonId });

    expectRunResult(await resumeDeepThonk(runDir, new FakeDriver()));
    const events = await readJsonl<{ type?: string; candidate_id?: string; comparison_id?: string }>(join(runDir, "events.jsonl"));

    expect(events).not.toContainEqual(expect.objectContaining({ type: expect.stringMatching(/^candidate\./), candidate_id: staleCandidateId }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: expect.stringMatching(/^comparison\./), comparison_id: staleComparisonId }));
  });

  it("refuses to replay traces from a different package version", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-version-"));
    await writeFile(join(runDir, "config.json"), JSON.stringify({ ...quickConfig(runDir), version: "0.0.1" }, null, 2), "utf8");

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.version_mismatch" });
  });

  it("refuses to replay a run with a live worker pid", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-live-"));
    await writeFile(
      join(runDir, "config.json"),
      JSON.stringify({ ...quickConfig(runDir), version: await currentCoreVersion() }, null, 2),
      "utf8"
    );
    await writeFile(
      join(runDir, "status.json"),
      JSON.stringify(
        {
          run_id: "run_live",
          run_dir: runDir,
          state: "running",
          phase: "generation_comparisons",
          generation: 1,
          usage: { calls: 4, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          worker_pid: process.pid,
          updated_at: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.in_flight" });
  });

  it("refuses provider-routed configs that do not match the runtime driver", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-provider-"));
    await writeStoredConfig(runDir, {
      ...quickConfig(runDir),
      providers: {
        judge: {
          provider: "deepseek",
          model: "deepseek-v4-pro"
        }
      }
    });

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.provider_mismatch" });
  });

  it("allows only one concurrent resume to claim the run lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-lock-"));
    const config = quickConfig(runDir);

    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const results = await Promise.allSettled([
      resumeDeepThonk(runDir, new SlowDriver()),
      resumeDeepThonk(runDir, new SlowDriver())
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "run.directory_locked" });
  });

  it("refuses stored configs missing the output block", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-incomplete-config-"));
    const { output: _output, ...configWithoutOutput } = quickConfig(runDir);
    await writeStoredConfig(runDir, configWithoutOutput);

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.config_incomplete" });
  });

  it("preserves winner and rank order when replaying from a killed stream", async () => {
    const fullDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-full-"));
    const interruptedDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-interrupted-"));
    const full = await runDeepThonk(quickConfig(fullDir, 777), new FakeDriver());

    await expect(runDeepThonk(quickConfig(interruptedDir, 777), new FailOnCallDriver(5))).rejects.toThrow(/Injected failure/);
    const resumed = expectRunResult(await resumeDeepThonk(interruptedDir, new FakeDriver()));

    const fullSummary = await readSummary(fullDir);
    const resumedSummary = await readSummary(interruptedDir);
    expect(resumed.winner.id).toBe(full.winner.id);
    expect(resumedSummary.winner_id).toBe(fullSummary.winner_id);
    // Byte-identical artifacts are not expected across independent directories because run IDs
    // and timestamps are intentionally fresh; the deterministic replay contract is rank identity.
    expect(scoreOrder(resumedSummary)).toEqual(scoreOrder(fullSummary));
  });
});

function quickConfig(runDir: string, seed = 42): RunConfig {
  return {
    task: "solve toy",
    profile: builtInProfiles.quick,
    runDir,
    seed,
    provider: "fake",
    generatorModel: "fake-model",
    mutatorModel: "fake-model",
    judgeModel: "fake-model",
    concurrency: { generate: 1, judge: 1, mutate: 1 },
    retry: { httpRetries: 0, invalidJsonRetries: 1 },
    output: { includeRawModelOutputs: false, includePrompts: false }
  };
}

function expectRunResult(result: RunResult | unknown): RunResult {
  expect(result).toHaveProperty("winner");
  return result as RunResult;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as T) : [];
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

async function writeStoredConfig(runDir: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(runDir, "config.json"), JSON.stringify({ ...config, version: await currentCoreVersion() }, null, 2), "utf8");
}

function candidateRow(id: string, generation: number): Record<string, unknown> {
  return {
    id,
    generation,
    kind: generation === 0 ? "initial" : "mutation",
    content: `candidate ${id}`,
    status: generation === 0 ? "generated" : "mutated",
    metadata: { createdAt: "2026-01-01T00:00:00.000Z" }
  };
}

function comparisonRow(id: string): Record<string, unknown> {
  return {
    id,
    runId: "stale_run",
    generation: 999,
    candidateAId: "candidate_a",
    candidateBId: "candidate_b",
    presentedAOriginalId: "candidate_a",
    presentedBOriginalId: "candidate_b",
    winner: "tie",
    critiqueForA: "",
    critiqueForB: "",
    selectionReason: "stale"
  };
}

async function readSummary(runDir: string): Promise<{ winner_id: string; final_scores: Array<{ candidateId: string; rank: number }> }> {
  return JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as {
    winner_id: string;
    final_scores: Array<{ candidateId: string; rank: number }>;
  };
}

function scoreOrder(summary: { final_scores: Array<{ candidateId: string; rank: number }> }): string[] {
  return [...summary.final_scores].sort((left, right) => left.rank - right.rank).map((score) => score.candidateId);
}

async function currentCoreVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL("../../packages/core/package.json", import.meta.url), "utf8")) as { version: string };
  return packageJson.version;
}

class FailAfterRoleCallDriver implements ModelDriver {
  private readonly inner = new FakeDriver();
  private calls = 0;

  constructor(
    private readonly role: "compare" | "mutate",
    private readonly failAfterSuccessfulCalls: number
  ) {}

  generate(input: GenerateInput): Promise<ModelTextResult> {
    return this.inner.generate(input);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    if (this.role !== "compare") return this.inner.compare(input);
    this.calls += 1;
    if (this.calls > this.failAfterSuccessfulCalls) throw new Error("Injected compare failure.");
    return this.inner.compare(input);
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    if (this.role !== "mutate") return this.inner.mutate(input);
    this.calls += 1;
    if (this.calls > this.failAfterSuccessfulCalls) throw new Error("Injected mutate failure.");
    return this.inner.mutate(input);
  }

  finalize(input: FinalizeInput): Promise<ModelTextResult> {
    return this.inner.finalize(input);
  }
}

class FailOnCallDriver implements ModelDriver {
  private readonly inner = new FakeDriver();
  private calls = 0;

  constructor(private readonly failAtCall: number) {}

  generate(input: GenerateInput): Promise<ModelTextResult> {
    return this.gated(() => this.inner.generate(input));
  }

  compare(input: CompareInput): Promise<ModelTextResult> {
    return this.gated(() => this.inner.compare(input));
  }

  mutate(input: MutateInput): Promise<ModelTextResult> {
    return this.gated(() => this.inner.mutate(input));
  }

  finalize(input: FinalizeInput): Promise<ModelTextResult> {
    return this.gated(() => this.inner.finalize(input));
  }

  private async gated(call: () => Promise<ModelTextResult>): Promise<ModelTextResult> {
    this.calls += 1;
    if (this.calls === this.failAtCall) throw new Error(`Injected failure at call ${this.calls}.`);
    return call();
  }
}

class SlowDriver implements ModelDriver {
  private readonly inner = new FakeDriver();

  async generate(input: GenerateInput): Promise<ModelTextResult> {
    await delay();
    return this.inner.generate(input);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    await delay();
    return this.inner.compare(input);
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    await delay();
    return this.inner.mutate(input);
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    await delay();
    return this.inner.finalize(input);
  }
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
