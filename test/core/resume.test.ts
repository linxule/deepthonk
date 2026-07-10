import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtInProfiles,
  repairLegacyBudgetConfig,
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
import { createDriver, FakeDriver, providerConfigFromReplay, providerReplayFromConfig } from "@deepthonk/providers";
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

  it.each(["summary", "final", "winner"])("validates the committed %s artifact before reporting a run complete", async (artifact) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-final-artifact-"));
    await runDeepThonk(quickConfig(runDir), new FakeDriver());
    if (artifact === "summary") {
      const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as Record<string, unknown>;
      summary.winner_id = "tampered-winner";
      await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    } else {
      await writeFile(join(runDir, "artifacts", `${artifact}.txt`), "tampered artifact\n", "utf8");
    }
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
  });

  it("binds finalizer usage into the finalizing commit", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-final-usage-"));
    await runDeepThonk({ ...quickConfig(runDir), finalizerModel: "fake-model" }, new FakeDriver());
    const usage = await readJsonl<Record<string, unknown>>(join(runDir, "usage.jsonl"));
    const finalizer = usage.find((record) => record.phase === "finalize")!;
    finalizer.output_tokens = Number(finalizer.output_tokens) + 1;
    finalizer.total_tokens = Number(finalizer.total_tokens) + 1;
    await writeFile(join(runDir, "usage.jsonl"), usage.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
  });

  it.each(["before_commit", "after_commit"])("recovers a finalizing crash window %s", async (window) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-final-crash-"));
    await runDeepThonk({ ...quickConfig(runDir), finalizerModel: "fake-model" }, new FakeDriver());
    const events = await readJsonl<Record<string, unknown>>(join(runDir, "events.jsonl"));
    await writeFile(
      join(runDir, "events.jsonl"),
      events
        .filter((event) => !(event.type === "phase.completed" && event.phase === "finalizing"))
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf8"
    );
    if (window === "before_commit") await rm(join(runDir, "commits", "finalizing.json"));

    const result = expectRunResult(await resumeDeepThonk(runDir, new FakeDriver()));
    expect(result.calls).toBe(16);
    expect((await readJsonl<Record<string, unknown>>(join(runDir, "usage.jsonl"))).filter((row) => row.phase === "finalize")).toHaveLength(1);
    await expect(readFile(join(runDir, "commits", "finalizing.json"), "utf8")).resolves.toContain('"schema_version": 2');
  });

  it("fails closed when finalizing was marked complete but summary.json is missing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-final-summary-missing-"));
    await runDeepThonk(quickConfig(runDir), new FakeDriver());
    await rm(join(runDir, "summary.json"));
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
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
    expect(result.calls).toBeGreaterThan(15);
    const usage = await readJsonl<{ outcome?: string }>(join(runDir, "usage.jsonl"));
    expect(usage).toHaveLength(result.calls);
    expect(usage).toContainEqual(expect.objectContaining({ outcome: "failed" }));
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
    expect(result.calls).toBeGreaterThan(15);
    const usage = await readJsonl<{ outcome?: string }>(join(runDir, "usage.jsonl"));
    expect(usage).toHaveLength(result.calls);
    expect(usage).toContainEqual(expect.objectContaining({ outcome: "failed" }));
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

  it("rejects phase markers that are not a strict completed prefix", () => {
    const config = quickConfig("runs/prefix-test");
    expect(() =>
      buildResumePlan(config, [
        { type: "phase.completed", phase: "generation_judging", generation: 1, at: new Date().toISOString() }
      ])
    ).toThrowError(expect.objectContaining({ code: "resume.phase_order_invalid" }));
  });

  it("detects and explicitly repairs legacy-redacted numeric budget fields", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-budget-repair-"));
    await writeStoredConfig(runDir, {
      ...quickConfig(runDir),
      budget: { maxInputTokens: "[redacted]", maxOutputTokens: "[redacted]" }
    });
    await expect(resumeDeepThonk(runDir, new FakeDriver(), { dryRun: true })).rejects.toMatchObject({
      code: "resume.legacy_redacted_budget"
    });

    await expect(
      repairLegacyBudgetConfig(runDir, { "budget.maxInputTokens": 1000, "budget.maxOutputTokens": 500 })
    ).resolves.toEqual(["budget.maxInputTokens", "budget.maxOutputTokens"]);
    const repaired = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as { budget: Record<string, unknown> };
    expect(repaired.budget).toMatchObject({ maxInputTokens: 1000, maxOutputTokens: 500 });
    const events = await readJsonl<{ type: string; fields?: string[] }>(join(runDir, "events.jsonl"));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "config.repaired", fields: ["budget.maxInputTokens", "budget.maxOutputTokens"] })
    );
  });

  it("rejects a substituted pair even when comparison count and IDs remain valid", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-pair-tamper-"));
    const config = quickConfig(runDir);
    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("mutate", 0))).rejects.toThrow(/Injected mutate failure/);
    const population = JSON.parse(await readFile(join(runDir, "population-0.json"), "utf8")) as Array<{ id: string }>;
    const comparisons = await readJsonl<Record<string, unknown>>(join(runDir, "comparisons.jsonl"));
    const generationRows = comparisons.filter((row) => row.generation === 1);
    const used = new Set(
      generationRows.map((row) => [String(row.candidateAId), String(row.candidateBId)].sort().join("::"))
    );
    let replacement: [string, string] | undefined;
    for (let left = 0; left < population.length; left += 1) {
      for (let right = left + 1; right < population.length; right += 1) {
        const pair: [string, string] = [population[left].id, population[right].id];
        if (!used.has([...pair].sort().join("::"))) replacement = pair;
      }
    }
    expect(replacement).toBeDefined();
    const target = generationRows[0]!;
    target.candidateAId = replacement![0];
    target.candidateBId = replacement![1];
    target.presentedAOriginalId = replacement![0];
    target.presentedBOriginalId = replacement![1];
    await writeFile(join(runDir, "comparisons.jsonl"), comparisons.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.comparison_schedule_mismatch" });
  });

  it("rejects population content that disagrees with candidates.jsonl", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-population-tamper-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 0))).rejects.toThrow(/Injected compare failure/);
    const population = JSON.parse(await readFile(join(runDir, "population-0.json"), "utf8")) as Array<{ content: string }>;
    population[0]!.content = "tampered content";
    await writeFile(join(runDir, "population-0.json"), JSON.stringify(population, null, 2), "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.population_mismatch" });
  });

  it("rejects structurally impossible append-only usage rows", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-usage-tamper-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 0))).rejects.toThrow(/Injected compare failure/);
    await appendJsonl(join(runDir, "usage.jsonl"), {
      schema_version: 1,
      ts: new Date().toISOString(),
      phase: "gen1_judge",
      role: "judge",
      input_tokens: -1,
      output_tokens: 0,
      total_tokens: 0
    });
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.usage_invalid" });
  });

  it.each([
    ["out-of-range confidence", (row: Record<string, unknown>) => { row.confidence = 2; }, "resume.comparison_row_invalid"],
    ["non-string provider", (row: Record<string, unknown>) => { row.provider = 42; }, "resume.comparison_row_invalid"],
    ["array metadata", (row: Record<string, unknown>) => { row.metadata = []; }, "resume.comparison_row_invalid"],
    ["oversized critique", (row: Record<string, unknown>) => { row.critiqueForA = "x".repeat(1_048_577); }, "resume.comparison_row_invalid"],
    ["different run ID", (row: Record<string, unknown>) => { row.runId = "different-run"; }, "resume.run_id_mismatch"]
  ])("rejects completed comparison rows with %s", async (_label, mutate, expectedCode) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-comparison-row-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("mutate", 0))).rejects.toThrow(/Injected mutate failure/);
    const comparisons = await readJsonl<Record<string, unknown>>(join(runDir, "comparisons.jsonl"));
    const target = comparisons.find((row) => row.generation === 1)!;
    mutate(target);
    await writeFile(join(runDir, "comparisons.jsonl"), comparisons.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: expectedCode });
  });

  it("accepts independently bounded raw critiques whose cumulative aggregate exceeds the mutation cap", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-long-raw-critiques-"));
    const config = quickConfig(runDir);
    config.critiqueLimits = { aggregateChars: 512 };
    await expect(runDeepThonk(config, new LongCritiqueFailMutationDriver())).rejects.toThrow(/Injected mutation failure/);

    await expect(resumeDeepThonk(runDir, new FakeDriver())).resolves.toHaveProperty("winner");
  });

  it("requires failed usage outcomes to carry a bounded error code", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-usage-outcome-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 0))).rejects.toThrow(/Injected compare failure/);
    const usage = await readJsonl<Record<string, unknown>>(join(runDir, "usage.jsonl"));
    usage[0]!.outcome = "failed";
    delete usage[0]!.error_code;
    await writeFile(join(runDir, "usage.jsonl"), usage.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.usage_invalid" });
  });

  it("rejects config model tampering against providerReplay before replay", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-model-tamper-"));
    const config = replayConfig(runDir);
    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 0))).rejects.toThrow(/Injected compare failure/);
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as Record<string, unknown>;
    stored.generatorModel = "tampered-model";
    await writeFile(join(runDir, "config.json"), JSON.stringify(stored, null, 2), "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.provider_replay_mismatch" });
  });

  it("recomputes the stored providerReplay fingerprint before replay", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-fingerprint-tamper-"));
    const config = replayConfig(runDir);
    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 0))).rejects.toThrow(/Injected compare failure/);
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as {
      providerReplay: Record<string, unknown>;
    };
    stored.providerReplay.baseUrl = "https://tampered.invalid/v1";
    await writeFile(join(runDir, "config.json"), JSON.stringify(stored, null, 2), "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.provider_replay_mismatch" });
  });

  it("accepts an untampered providerReplay fingerprint with the matching runtime route", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-fingerprint-valid-"));
    const config = replayConfig(runDir);
    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 0))).rejects.toThrow(/Injected compare failure/);
    const replay = config.providerReplay!;
    await expect(resumeDeepThonk(runDir, createDriver(providerConfigFromReplay(replay)))).resolves.toHaveProperty("winner");
  });

  it("reuses only validated v2 item receipts from an interrupted phase", async () => {
    const fullDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-receipts-full-"));
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-receipts-"));
    const withPrices = (dir: string): RunConfig => ({
      ...quickConfig(dir),
      budget: {
        prices: [{ provider: "fake", model: "fake-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]
      }
    });
    await runDeepThonk(withPrices(fullDir), new FakeDriver());
    await expect(runDeepThonk(withPrices(runDir), new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const driver = new CountingDriver();
    const result = expectRunResult(await resumeDeepThonk(runDir, driver));
    expect(result.calls).toBe(16);
    // Three missing generation-1 comparisons plus four final comparisons.
    expect(driver.compareCalls).toBe(7);
    const fullSummary = JSON.parse(await readFile(join(fullDir, "summary.json"), "utf8")) as { usage: Record<string, number> };
    const resumedSummary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as { usage: Record<string, number> };
    expect(resumedSummary.usage.inputTokens).toBe(fullSummary.usage.inputTokens);
    expect(resumedSummary.usage.outputTokens).toBe(fullSummary.usage.outputTokens);
    expect(resumedSummary.usage.totalTokens).toBe(fullSummary.usage.totalTokens);
    expect(resumedSummary.usage.usd).toBeCloseTo(fullSummary.usage.usd);
  });

  it("reschedules a corrupted incomplete receipt instead of trusting it", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-corrupt-incomplete-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const value = JSON.parse(await readFile(checkpoint, "utf8")) as { output: { critiqueForA: string } };
    value.output.critiqueForA += " tampered";
    await writeFile(checkpoint, JSON.stringify(value, null, 2), "utf8");

    const driver = new CountingDriver();
    const result = expectRunResult(await resumeDeepThonk(runDir, driver));
    expect(result.calls).toBe(17);
    // All four generation-1 comparisons were missing/invalid, plus four final.
    expect(driver.compareCalls).toBe(8);
  });

  it("reschedules an incomplete receipt with invalid attempt provenance", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-invalid-attempt-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const value = JSON.parse(await readFile(checkpoint, "utf8")) as { attempt_id: string };
    value.attempt_id = "not-an-attempt-id";
    await writeFile(checkpoint, JSON.stringify(value, null, 2), "utf8");

    const driver = new CountingDriver();
    const result = expectRunResult(await resumeDeepThonk(runDir, driver));
    expect(result.calls).toBe(17);
    expect(driver.compareCalls).toBe(8);
  });

  it("recreates a missing prompt CAS blob instead of reusing a dangling receipt", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-missing-prompt-"));
    const config = quickConfig(runDir);
    config.output.includePrompts = true;
    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const receipt = JSON.parse(await readFile(checkpoint, "utf8")) as {
      output: { metadata: { promptRef: { sha256: string; path: string } } };
    };
    const promptRef = receipt.output.metadata.promptRef;
    await rm(join(runDir, promptRef.path));

    const driver = new CountingDriver();
    const result = expectRunResult(await resumeDeepThonk(runDir, driver));
    expect(result.calls).toBe(17);
    expect(driver.compareCalls).toBe(8);
    const restored = await readFile(join(runDir, promptRef.path), "utf8");
    expect(restored).toContain('"system"');
  });

  it("fails closed when a prompt CAS blob was tampered", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-tampered-prompt-"));
    const config = quickConfig(runDir);
    config.output.includePrompts = true;
    await expect(runDeepThonk(config, new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const receipt = JSON.parse(await readFile(checkpoint, "utf8")) as {
      output: { metadata: { promptRef: { path: string } } };
    };
    await writeFile(join(runDir, receipt.output.metadata.promptRef.path), "tampered\n", "utf8");

    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toThrow(/Prompt blob hash mismatch/);
  });

  it("rejects checkpoint tampering in a committed v2 phase", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-corrupt-committed-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("mutate", 0))).rejects.toThrow(/Injected mutate failure/);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const value = JSON.parse(await readFile(checkpoint, "utf8")) as { output: { selectionReason: string } };
    value.output.selectionReason = "tampered";
    await writeFile(checkpoint, JSON.stringify(value, null, 2), "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
  });

  it.each([
    ["attempt_id", "123e4567-e89b-42d3-a456-426614174000"],
    ["completed_at", "2025-01-01T00:00:00.000Z"]
  ])("binds checkpoint provenance field %s into committed phase integrity", async (field, replacement) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-provenance-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("mutate", 0))).rejects.toThrow(/Injected mutate failure/);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const value = JSON.parse(await readFile(checkpoint, "utf8")) as Record<string, unknown>;
    value[field] = replacement;
    await writeFile(checkpoint, JSON.stringify(value, null, 2), "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
  });

  it("rebuilds a missing phase commit without repeating completed receipts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-rebuild-commit-"));
    await expect(runDeepThonk(quickConfig(runDir), new BreakScoreWriteDriver(runDir))).rejects.toThrow();
    await rm(join(runDir, "scores.jsonl"), { recursive: true, force: true });

    const driver = new CountingDriver();
    const result = expectRunResult(await resumeDeepThonk(runDir, driver));
    expect(result.calls).toBe(15);
    // Generation-1 comparison receipts were complete; only final ranking ran.
    expect(driver.compareCalls).toBe(4);
    await expect(readFile(join(runDir, "commits", "generation_judging_3A1.json"), "utf8")).resolves.toContain(
      '"schema_version": 2'
    );
  });

  it("keeps legacy v1 traces on conservative whole-phase replay", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v1-whole-phase-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    await Promise.all(
      ["manifests", "checkpoints", "commits"].map((directory) => rm(join(runDir, directory), { recursive: true, force: true }))
    );
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as Record<string, unknown>;
    delete stored.traceSchemaVersion;
    await writeFile(join(runDir, "config.json"), JSON.stringify(stored, null, 2), "utf8");

    const driver = new CountingDriver();
    const result = expectRunResult(await resumeDeepThonk(runDir, driver));
    expect(result.calls).toBe(17);
    expect(driver.compareCalls).toBe(8);
  });

  it("fails closed on malformed trace-v2 manifests", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-v2-bad-manifest-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("compare", 1))).rejects.toThrow(/Injected compare failure/);
    await writeFile(join(runDir, "manifests", "generation_judging_3A1.json"), "{not-json\n", "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
  });

  it("binds every invalid-JSON retry usage row into its checkpoint receipt", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-v2-retry-usage-"));
    const result = await runDeepThonk(quickConfig(runDir), new InvalidOncePerComparisonDriver());
    expect(result.calls).toBe(23);
    const checkpoint = await firstCheckpoint(runDir, "generation_judging_3A1");
    const receipt = JSON.parse(await readFile(checkpoint, "utf8")) as { usage: unknown[]; usage_hash: string };
    expect(receipt.usage).toHaveLength(2);
    expect(receipt.usage_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each(["delete", "duplicate"])("rejects %s materialized usage rows from a committed phase", async (operation) => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-v2-usage-materialization-"));
    await expect(runDeepThonk(quickConfig(runDir), new FailAfterRoleCallDriver("mutate", 0))).rejects.toThrow(/Injected mutate failure/);
    const usage = await readJsonl<Record<string, unknown>>(join(runDir, "usage.jsonl"));
    const index = usage.findIndex((record) => record.phase === "gen1_judge");
    expect(index).toBeGreaterThanOrEqual(0);
    if (operation === "delete") usage.splice(index, 1);
    else usage.splice(index, 0, { ...usage[index] });
    await writeFile(join(runDir, "usage.jsonl"), usage.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    await expect(resumeDeepThonk(runDir, new FakeDriver())).rejects.toMatchObject({ code: "resume.trace_v2_integrity" });
  });
});

async function firstCheckpoint(runDir: string, phaseDirectory: string): Promise<string> {
  const directory = join(runDir, "checkpoints", phaseDirectory);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  return join(directory, files[0]);
}

function replayConfig(runDir: string): RunConfig {
  const config = quickConfig(runDir);
  config.providerReplay = providerReplayFromConfig({
    provider: "fake",
    supportsJsonMode: true,
    models: { generator: "fake-model", mutator: "fake-model", judge: "fake-model" }
  });
  return config;
}

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

class CountingDriver extends FakeDriver {
  compareCalls = 0;

  override compare(input: CompareInput): Promise<ModelTextResult> {
    this.compareCalls += 1;
    return super.compare(input);
  }
}

class BreakScoreWriteDriver extends FakeDriver {
  private compareCalls = 0;

  constructor(private readonly runDir: string) {
    super();
  }

  override async compare(input: CompareInput): Promise<ModelTextResult> {
    this.compareCalls += 1;
    const result = await super.compare(input);
    if (this.compareCalls === 4) await mkdir(join(this.runDir, "scores.jsonl"));
    return result;
  }
}

class InvalidOncePerComparisonDriver extends FakeDriver {
  private readonly attempts = new Map<string, number>();

  override async compare(input: CompareInput): Promise<ModelTextResult> {
    const key = [input.candidateA.id, input.candidateB.id].sort().join("::");
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const result = await super.compare(input);
    return attempt === 1 ? { ...result, text: "invalid json" } : result;
  }
}

class LongCritiqueFailMutationDriver extends FakeDriver {
  override async compare(input: CompareInput): Promise<ModelTextResult> {
    const result = await super.compare(input);
    return {
      ...result,
      text: JSON.stringify({
        winner: "A",
        feedback_a: "a".repeat(20_000),
        feedback_b: "b".repeat(20_000),
        selection_reason: "bounded raw critique"
      })
    };
  }

  override mutate(): Promise<ModelTextResult> {
    throw new Error("Injected mutation failure.");
  }
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
