import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deepthonkCancel,
  deepthonkPlan,
  deepthonkResult,
  deepthonkRun,
  deepthonkStart,
  deepthonkStatus,
  statusOutputSchema,
  promptNames,
  readRunResource,
  resourceTemplates,
  runArgsSchema,
  toolNames
} from "@deepthonk/mcp";

describe("MCP helpers", () => {
  it("lists expected surfaces", () => {
    expect(toolNames).toContain("deepthonk.plan");
    expect(toolNames).toContain("deepthonk.start");
    expect(toolNames).toContain("deepthonk.status");
    expect(toolNames).toContain("deepthonk.result");
    expect(toolNames).toContain("deepthonk.cancel");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/summary");
    expect(promptNames).toContain("deepthonk/compare");
  });

  it("starts, polls, and reads result for a fake background job", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-job-"));
    const started = await deepthonkStart({
      task: "toy",
      profile: "quick",
      provider: "fake",
      seed: 8,
      run_dir: runDir
    });
    expect(started.job_id).toBeTruthy();
    let result = await deepthonkResult({ run_dir: runDir });
    for (let attempt = 0; attempt < 20 && !result.complete; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await deepthonkResult({ run_dir: runDir });
    }
    expect(result.complete).toBe(true);
    expect(result.run_id).toBeTruthy();
    const status = await deepthonkStatus({ run_dir: runDir });
    expect(status.state).toBe("completed");
    await expect(deepthonkStatus({ run_dir: runDir, job_id: "wrong-job" })).rejects.toMatchObject({ code: "mcp.job_mismatch" });
  });

  it("records cancellation requests in the run directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-cancel-"));
    const cancelled = await deepthonkCancel({ run_dir: runDir });
    expect(cancelled.cancel_requested).toBe(true);
    const status = await deepthonkStatus({ run_dir: runDir });
    expect(status.status).toBe("cancel_requested");
  });

  it("plans and runs with fake provider", async () => {
    expect(deepthonkPlan({ profile: "paper" }).calls).toBe(285);
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-"));
    const result = await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "fake",
      seed: 7,
      run_dir: runDir
    });
    expect(result.winner_id).toBeTruthy();
    const summary = await readRunResource(String(result.summary_resource), join(runDir, ".."));
    expect(summary).toContain(String(result.winner_id));
    const runs = await readRunResource("deepthonk://runs", join(runDir, ".."));
    expect(runs).toContain(String(result.run_id));
  });

  it("does not advertise deferred MCP Sampling as a provider", () => {
    expect(runArgsSchema.safeParse({ task: "toy", provider: "sampling" }).success).toBe(false);
    expect(runArgsSchema.safeParse({ task: "toy", provider: "openrouter" }).success).toBe(true);
  });

  it("runs with provider settings from config_path", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-config-"));
    const configPath = join(root, "config.yaml");
    const runDir = join(root, "run");
    await writeFile(configPath, ["profile: quick", "provider: fake", "models:", "  generator: fake-model", "  mutator: fake-model", "  judge: fake-model"].join("\n"));

    const result = await deepthonkRun({
      task: "toy",
      config_path: configPath,
      run_dir: runDir
    });

    expect(result.winner_id).toBeTruthy();
  });

  it("honors MCP config output and concurrency fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-config-parity-"));
    const configPath = join(root, "config.yaml");
    const runDir = join(root, "run");
    await writeFile(
      configPath,
      [
        "profile: quick",
        "provider: fake",
        "concurrency:",
        "  generate: 1",
        "  judge: 1",
        "  mutate: 1",
        "output:",
        "  includePrompts: true"
      ].join("\n")
    );
    await deepthonkRun({ task: "toy", config_path: configPath, run_dir: runDir });
    const firstCandidate = JSON.parse((await readFile(join(runDir, "candidates.jsonl"), "utf8")).trim().split("\n")[0]) as {
      metadata?: { prompt?: unknown };
    };
    expect(firstCandidate.metadata?.prompt).toBeTruthy();
  });

  it("exports non-empty MCP status output schema", () => {
    expect(Object.keys(statusOutputSchema.shape).length).toBeGreaterThan(0);
  });

  it("passes MCP finalizer model through to the shared runner", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-finalizer-"));
    const result = await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "fake",
      finalizer_model: "fake-model",
      run_dir: runDir
    });

    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as { calls: number };
    expect(summary.calls).toBe(16);
  });
});
