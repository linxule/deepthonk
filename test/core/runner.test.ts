import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInProfiles, readRunStatus, runDeepThonk, TraceStore, type RunConfig } from "@deepthonk/core";
import { FakeDriver, type GenerateInput, type ModelTextResult } from "@deepthonk/providers";

describe("runDeepThonk", () => {
  it("completes quick profile with fake provider and writes trace", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-run-"));
    const config: RunConfig = {
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 42,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    const result = await runDeepThonk(config, new FakeDriver());
    expect(result.finalScores).toHaveLength(4);
    expect(result.calls).toBe(15);
    expect(result.winner.content).toContain("FAKE_QUALITY");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as {
      winner_id: string;
      profile_name: string | null;
    };
    expect(summary.winner_id).toBe(result.winner.id);
    expect(summary.profile_name).toBe("quick");
    await expect(readFile(join(runDir, "artifacts", "final.txt"), "utf8")).resolves.toContain("FAKE_QUALITY");
    const population = JSON.parse(await readFile(join(runDir, "population-1.json"), "utf8")) as Array<{ kind: string }>;
    expect(population).toHaveLength(4);
    expect(population.some((candidate) => candidate.kind === "elite-copy")).toBe(true);
    const candidateIds = new Set(
      (await readFile(join(runDir, "candidates.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { id: string }).id)
    );
    for (const candidate of population as Array<{ id: string }>) expect(candidateIds.has(candidate.id)).toBe(true);
    const comparisons = (await readFile(join(runDir, "comparisons.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { candidateAId: string; candidateBId: string; presentedAOriginalId: string; presentedBOriginalId: string });
    expect(comparisons.every((comparison) => comparison.candidateAId === comparison.presentedAOriginalId)).toBe(true);
    expect(comparisons.every((comparison) => comparison.candidateBId === comparison.presentedBOriginalId)).toBe(true);
  });

  it("writes resolved profile, prompt, model, and usage schema metadata", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-summary-"));
    const config: RunConfig = {
      task: "solve toy",
      profile: { ...builtInProfiles.quick, n: 3, t: 0 },
      runDir,
      seed: 42,
      provider: "fake",
      generatorModel: "fake-generator",
      mutatorModel: "fake-mutator",
      judgeModel: "fake-judge",
      concurrency: { generate: 3, judge: 3, mutate: 2 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    await runDeepThonk(config, new FakeDriver());

    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as {
      profile: { n: number };
      prompt_style: string;
      models: { judge: unknown };
    };
    expect(summary.profile.n).toBe(3);
    expect(summary.prompt_style).toBe("general");
    expect(summary.models.judge).toEqual(expect.any(String));

    const firstUsageLine = (await readFile(join(runDir, "usage.jsonl"), "utf8")).trim().split("\n")[0];
    expect(JSON.parse(firstUsageLine).schema_version).toBe(1);
  });

  it("keeps seeded trace IDs stable when provider responses resolve out of order", async () => {
    const [firstDir, secondDir] = await Promise.all([
      mkdtemp(join(tmpdir(), "deepthonk-stable-a-")),
      mkdtemp(join(tmpdir(), "deepthonk-stable-b-"))
    ]);
    const config = (runDir: string): RunConfig => ({
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 99,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    });
    const [first, second] = await Promise.all([
      runDeepThonk(config(firstDir), new DelayedFakeDriver()),
      runDeepThonk(config(secondDir), new DelayedFakeDriver())
    ]);
    expect(first.winner.id).toBe(second.winner.id);
    // Comparisons stream to disk in completion order, which varies across runs with the same seed
    // when provider responses resolve out of order. The deterministic invariant is the *set* of
    // recorded comparisons keyed by their seeded IDs, so compare sorted by ID with the run ID
    // tokens normalised.
    const parseJsonl = async (dir: string, runId: string): Promise<unknown[]> =>
      (await readFile(join(dir, "comparisons.jsonl"), "utf8"))
        .replaceAll(runId, "run")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string })
        .sort((left, right) => left.id.localeCompare(right.id));
    const firstComparisons = await parseJsonl(firstDir, first.runId);
    const secondComparisons = await parseJsonl(secondDir, second.runId);
    expect(firstComparisons).toEqual(secondComparisons);
  });

  it("refuses to append a second run into an existing trace directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-existing-"));
    const config: RunConfig = {
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 1,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    await runDeepThonk(config, new FakeDriver());
    await expect(runDeepThonk(config, new FakeDriver())).rejects.toThrow(/already contains/);
  });

  it("stops at a phase boundary when runtime budget is exceeded", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-budget-"));
    const config: RunConfig = {
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 1,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      budget: { maxInputTokens: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    await expect(runDeepThonk(config, new FakeDriver())).rejects.toThrow(/Budget exceeded/);
    await expect(readFile(join(runDir, "population-0.json"), "utf8")).rejects.toThrow(/ENOENT/);
    const status = await readRunStatus(runDir);
    expect(status?.state).toBe("budget_exceeded");
    expect(status?.error?.code).toBe("budget.input_tokens_exceeded");
  });

  it("records cancellation at the next safe phase boundary", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-cancel-"));
    const config: RunConfig = {
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 1,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    let checks = 0;
    await expect(
      runDeepThonk(config, new FakeDriver(), {
        shouldCancel: () => {
          checks += 1;
          return checks > 1;
        }
      })
    ).rejects.toThrow(/cancelled/i);
    const status = await readRunStatus(runDir);
    expect(status?.state).toBe("cancelled");
    expect(status?.error?.code).toBe("run.cancelled");
  });

  it("redacts key-like fields before writing config traces", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-redact-"));
    const config = {
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 1,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      apiKey: "do-not-write",
      nested: { secretToken: "do-not-write" },
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    } as RunConfig & { apiKey: string; nested: { secretToken: string } };
    await new TraceStore(runDir).init(config, "redaction-test");
    const traceConfig = await readFile(join(runDir, "config.json"), "utf8");
    expect(traceConfig).not.toContain("do-not-write");
    expect(traceConfig).toContain("[redacted]");
  });

  it("traces bottom-quartile and rounding discards for non-divisible populations", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-discard-"));
    const config: RunConfig = {
      task: "solve toy",
      profile: { ...builtInProfiles.quick, n: 6, k: 1, t: 1, m: 1 },
      runDir,
      seed: 1,
      provider: "fake",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      concurrency: { generate: 6, judge: 3, mutate: 4 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    await runDeepThonk(config, new FakeDriver());
    const candidates = (await readFile(join(runDir, "candidates.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status?: string; metadata?: { discardReason?: string } });
    const discarded = candidates.filter((candidate) => candidate.status === "discarded");
    expect(discarded.map((candidate) => candidate.metadata?.discardReason).sort()).toEqual(["bottom_quartile", "rounding_trim"]);
  });
});

class DelayedFakeDriver extends FakeDriver {
  override async generate(input: GenerateInput): Promise<ModelTextResult> {
    await new Promise((resolve) => setTimeout(resolve, (4 - (input.candidateIndex ?? 0)) * 2));
    return super.generate(input);
  }
}
