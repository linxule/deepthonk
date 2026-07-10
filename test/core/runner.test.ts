import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtInProfiles,
  claimRunLock,
  claimRunLockOwnership,
  inspectRunLock,
  reclaimRunLock,
  readRunStatus,
  releaseRunLock,
  runDeepThonk,
  TraceStore,
  type RunConfig
} from "@deepthonk/core";
import {
  FakeDriver,
  type CompareInput,
  type FinalizeInput,
  type GenerateInput,
  type ModelTextResult,
  type MutateInput
} from "@deepthonk/providers";

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

  it("claims and releases the fresh-run lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-lock-release-"));
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
    await expect(stat(join(runDir, "run.lock"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects a fresh run when the run directory is already locked", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-lock-held-"));
    const claimed = await claimRunLock(runDir, "external");
    expect(claimed).toBe(true);
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
    try {
      await expect(runDeepThonk(config, new FakeDriver())).rejects.toMatchObject({ code: "run.directory_locked" });
    } finally {
      await releaseRunLock(runDir);
    }
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

  it("drains failed phase work before recording run failure", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-failed-drain-"));
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
      retry: { httpRetries: 0, invalidJsonRetries: 0 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    await expect(runDeepThonk(config, new InvalidJudgeDriver())).rejects.toMatchObject({ code: "judge.persistent_invalid_json" });
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.at(-1)?.type).toBe("run.failed");
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
    const trace = new TraceStore(runDir);
    await trace.init(config, "redaction-test");
    await trace.close();
    const traceConfig = await readFile(join(runDir, "config.json"), "utf8");
    expect(traceConfig).not.toContain("do-not-write");
    expect(traceConfig).toContain("[redacted]");
  });

  it("preserves numeric token budgets while redacting actual token secrets", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-token-redact-"));
    const config = {
      ...baseConfig(runDir),
      budget: {
        maxInputTokens: 123,
        maxOutputTokens: 456,
        prices: [
          {
            provider: "fake",
            model: "fake-model",
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
            longContextThresholdTokens: 789,
            inputUsdPerMillionLong: 2,
            outputUsdPerMillionLong: 2
          }
        ]
      },
      secretToken: "do-not-write"
    } as RunConfig & { secretToken: string };
    const trace = new TraceStore(runDir);
    await trace.init(config, "token-redaction-test");
    await trace.close();
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as typeof config;
    expect(stored.budget.maxInputTokens).toBe(123);
    expect(stored.budget.maxOutputTokens).toBe(456);
    expect(stored.budget.prices[0]?.longContextThresholdTokens).toBe(789);
    expect(stored.secretToken).toBe("[redacted]");
  });

  it("honors a caller runId and rejects path-like IDs", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-run-id-"));
    const result = await runDeepThonk({ ...baseConfig(runDir), runId: "caller.run_42" }, new FakeDriver());
    expect(result.runId).toBe("caller.run_42");
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as { runId: string };
    expect(stored.runId).toBe("caller.run_42");

    const invalidDir = await mkdtemp(join(tmpdir(), "deepthonk-run-id-invalid-"));
    await expect(runDeepThonk({ ...baseConfig(invalidDir), runId: "../escape" }, new FakeDriver())).rejects.toThrow(/Run IDs/);
  });

  it("accepts maxCalls equal to the minimum logical plan and reserves calls atomically", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-max-calls-"));
    const result = await runDeepThonk({ ...baseConfig(runDir), budget: { maxCalls: 15 } }, new FakeDriver());
    expect(result.calls).toBe(15);
  });

  it("passes resolved per-role output caps to every ModelDriver call", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-output-caps-"));
    const driver = new OutputCapDriver();
    await runDeepThonk(
      {
        ...baseConfig(runDir),
        finalizerModel: "fake-model",
        modelOutputTokens: { generation: 111, mutation: 222, judge: 333, finalizer: 444 }
      },
      driver
    );
    expect(new Set(driver.generationCaps)).toEqual(new Set([111]));
    expect(new Set(driver.mutationCaps)).toEqual(new Set([222]));
    expect(new Set(driver.judgeCaps)).toEqual(new Set([333]));
    expect(new Set(driver.finalizerCaps)).toEqual(new Set([444]));
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as {
      critiqueLimits: { aggregateChars: number };
      modelOutputTokens: Record<string, number>;
    };
    expect(stored.modelOutputTokens).toEqual({ generation: 111, mutation: 222, judge: 333, finalizer: 444 });
    expect(stored.critiqueLimits.aggregateChars).toBe(16_000);
  });

  it("rejects an impossible explicit final rank schedule before any driver call", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-rank-preflight-"));
    const driver = new CountingGenerateDriver();
    await expect(
      runDeepThonk(
        { ...baseConfig(runDir), rank: { mode: "all-pairs", maxCalls: 5 } },
        driver
      )
    ).rejects.toMatchObject({ code: "rank.max_calls_exceeded" });
    expect(driver.generateCalls).toBe(0);
  });

  it.each([
    ["phase", (config: RunConfig) => ({ ...config, concurrency: { ...config.concurrency, generate: 1_025 } })],
    ["provider", (config: RunConfig) => ({ ...config, providerMaxConcurrency: 1_025 })]
  ])("rejects absurd %s concurrency during config validation", async (_label, mutate) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-concurrency-cap-"));
    const driver = new CountingGenerateDriver();
    // Assert the bound and the too-big semantics, not zod's exact phrasing: zod 3 said
    // "Number must be less than or equal to 1024", zod 4 says "Too big: expected number
    // to be <=1024" and serializes issues as JSON. The contract under test is that the
    // 1024 cap rejects before any provider call, not how zod words it.
    const error: unknown = await runDeepThonk(mutate(baseConfig(runDir)), driver).then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/too_big|too big|less than or equal to/i);
    expect(String((error as Error).message)).toMatch(/1024/);
    expect(driver.generateCalls).toBe(0);
  });

  it.each([
    { rank: { mode: "all-pairs" as const, maxCalls: 6 }, finalCalls: 6, totalCalls: 17 },
    { rank: { mode: "k-regular" as const, k: 1, maxCalls: 2 }, finalCalls: 2, totalCalls: 13 }
  ])("honors $rank.mode final ranking in a full run", async ({ rank, finalCalls, totalCalls }) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-rank-mode-"));
    const result = await runDeepThonk({ ...baseConfig(runDir), rank }, new FakeDriver());
    const comparisons = (await readFile(join(runDir, "comparisons.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { generation: number | "final" });
    expect(comparisons.filter((comparison) => comparison.generation === "final")).toHaveLength(finalCalls);
    expect(result.calls).toBe(totalCalls);
  });

  it("stores rendered prompts once as content-addressed blobs and traces references", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-prompt-refs-"));
    const config = baseConfig(runDir);
    config.output.includePrompts = true;
    const result = await runDeepThonk(config, new FakeDriver());
    const candidates = (await readFile(join(runDir, "candidates.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { generation: number; metadata: { prompt?: unknown; promptRef?: { sha256: string; path: string } } });
    const initialRefs = candidates.filter((candidate) => candidate.generation === 0).map((candidate) => candidate.metadata.promptRef);
    expect(initialRefs.every((reference) => reference?.sha256 === initialRefs[0]?.sha256)).toBe(true);
    expect(candidates.every((candidate) => candidate.metadata.prompt === undefined)).toBe(true);
    const promptFiles = await readdir(join(runDir, "artifacts", "prompts"));
    expect(promptFiles.length).toBeLessThan(result.calls);
    const prompt = await new TraceStore(runDir).readPrompt(initialRefs[0]!);
    expect(prompt.user).toContain("solve toy");
  });

  it("automatically reclaims only a same-host dead-pid lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-stale-lock-"));
    await writeFile(
      join(runDir, "run.lock"),
      `${JSON.stringify({
        schema_version: 1,
        claim_id: "stale-claim",
        job_id: "stale-job",
        hostname: hostname(),
        worker_pid: 2_147_483_647,
        claimed_at: new Date().toISOString()
      })}\n`,
      "utf8"
    );
    expect(await claimRunLock(runDir, "new-job")).toBe(true);
    const inspection = await inspectRunLock(runDir);
    expect(inspection).toMatchObject({ state: "valid", lock: { job_id: "new-job", worker_pid: process.pid } });
    await releaseRunLock(runDir);
  });

  it("allows only a matching preflight pending status for a preclaimed job", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-preflight-"));
    const claimed = await claimRunLockOwnership(runDir, "job-1");
    expect(claimed).toBeDefined();
    await writeFile(join(runDir, "status.json"), JSON.stringify({ state: "pending", job_id: "job-1" }), "utf8");
    await expect(runDeepThonk(baseConfig(runDir), new FakeDriver(), { jobId: "job-1", lockClaim: claimed! })).resolves.toHaveProperty("winner");
    await releaseRunLock(runDir, claimed!.claimId);

    const mismatchDir = await mkdtemp(join(tmpdir(), "deepthonk-preflight-mismatch-"));
    await writeFile(join(mismatchDir, "status.json"), JSON.stringify({ state: "pending", job_id: "other-job" }), "utf8");
    await expect(new TraceStore(mismatchDir).init(baseConfig(mismatchDir), "preflight-run", { pendingJobId: "job-1" })).rejects.toThrow(
      /already contains status.json/
    );
  });

  it("rejects forged preclaim authority and restores locks after a fingerprint mismatch", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-forged-lock-"));
    const claim = await claimRunLockOwnership(runDir, "real-job");
    expect(claim).toBeDefined();
    const [reclaimed, competingClaim] = await Promise.all([
      reclaimRunLock(runDir, "sha256:" + "0".repeat(64)),
      claimRunLockOwnership(runDir, "competing-job")
    ]);
    expect(reclaimed).toBe(false);
    expect(competingClaim).toBeUndefined();
    await expect(stat(join(runDir, "run.lock"))).resolves.toBeDefined();
    await expect(
      runDeepThonk(baseConfig(runDir), new FakeDriver(), {
        jobId: "real-job",
        lockClaim: { ...claim!, claimId: "forged-claim" }
      })
    ).rejects.toMatchObject({ code: "run.lock_not_owned" });
    await releaseRunLock(runDir, claim!.claimId);
  });

  it("keeps providerReplay env var pointers while redacting secret values", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-replay-redact-"));
    const config = {
      task: "solve toy",
      profile: builtInProfiles.quick,
      runDir,
      seed: 1,
      provider: "openai-compatible",
      generatorModel: "fake-model",
      mutatorModel: "fake-model",
      judgeModel: "fake-model",
      providerReplay: {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        apiKeyEnv: "TEST_PROVIDER_KEY",
        supportsJsonMode: false,
        models: { generator: "fake-model", mutator: "fake-model", judge: "fake-model" },
        roleProviders: {
          judge: {
            provider: "deepseek",
            apiKeyEnv: "JUDGE_KEY",
            model: "deepseek-v4-pro",
            supportsJsonMode: true
          }
        }
      },
      apiKey: "do-not-write",
      authorization: "Bearer do-not-write",
      concurrency: { generate: 4, judge: 4, mutate: 3 },
      retry: { httpRetries: 0, invalidJsonRetries: 1 },
      output: { includeRawModelOutputs: false, includePrompts: false }
    } as RunConfig & { apiKey: string; authorization: string };
    const trace = new TraceStore(runDir);
    await trace.init(config, "redaction-test");
    await trace.close();

    const traceConfigText = await readFile(join(runDir, "config.json"), "utf8");
    const traceConfig = JSON.parse(traceConfigText) as typeof config;
    expect(traceConfigText).not.toContain("do-not-write");
    expect(traceConfig.providerReplay.apiKeyEnv).toBe("TEST_PROVIDER_KEY");
    expect(traceConfig.providerReplay.roleProviders?.judge?.apiKeyEnv).toBe("JUDGE_KEY");
    expect((traceConfig as { apiKey: string }).apiKey).toBe("[redacted]");
    expect((traceConfig as { authorization: string }).authorization).toBe("[redacted]");
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

function baseConfig(runDir: string): RunConfig {
  return {
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
}

class DelayedFakeDriver extends FakeDriver {
  override async generate(input: GenerateInput): Promise<ModelTextResult> {
    await new Promise((resolve) => setTimeout(resolve, (4 - (input.candidateIndex ?? 0)) * 2));
    return super.generate(input);
  }
}

class InvalidJudgeDriver extends FakeDriver {
  override async compare(): Promise<ModelTextResult> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { text: "not json" };
  }
}

class OutputCapDriver extends FakeDriver {
  readonly generationCaps: Array<number | undefined> = [];
  readonly mutationCaps: Array<number | undefined> = [];
  readonly judgeCaps: Array<number | undefined> = [];
  readonly finalizerCaps: Array<number | undefined> = [];

  override generate(input: GenerateInput): Promise<ModelTextResult> {
    this.generationCaps.push(input.maxOutputTokens);
    return super.generate(input);
  }

  override compare(input: CompareInput): Promise<ModelTextResult> {
    this.judgeCaps.push(input.maxOutputTokens);
    return super.compare(input);
  }

  override mutate(input: MutateInput): Promise<ModelTextResult> {
    this.mutationCaps.push(input.maxOutputTokens);
    return super.mutate(input);
  }

  override finalize(input: FinalizeInput): Promise<ModelTextResult> {
    this.finalizerCaps.push(input.maxOutputTokens);
    return super.finalize(input);
  }
}

class CountingGenerateDriver extends FakeDriver {
  generateCalls = 0;

  override generate(input: GenerateInput): Promise<ModelTextResult> {
    this.generateCalls += 1;
    return super.generate(input);
  }
}
