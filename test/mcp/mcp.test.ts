import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { describe, expect, it } from "vitest";
import {
  deepthonkCancel,
  deepthonkPlan,
  deepthonkPlanAsync,
  deepthonkResult,
  deepthonkRun,
  deepthonkStart,
  deepthonkStatus,
  statusOutputSchema,
  isAllowedMcpHttpHost,
  promptNames,
  readRunResource,
  resourceTemplates,
  mutateArgsSchema,
  rankArgsSchema,
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
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/usage");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/population/{generation}");
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
    await expect(readRunResource(`deepthonk://runs/${String(result.run_id)}/config`, join(runDir, ".."))).resolves.toContain("\"provider\": \"fake\"");
    await expect(readRunResource(`deepthonk://runs/${String(result.run_id)}/usage`, join(runDir, ".."))).resolves.toContain("\"role\"");
    await expect(readRunResource(`deepthonk://runs/${String(result.run_id)}/population/0`, join(runDir, ".."))).resolves.toContain("\"kind\"");
  });

  it("loads a named profile via profile_name", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-profiles-"));
    await writeFile(
      join(profilesDir, "fake-balanced.yaml"),
      [
        "profile: balanced",
        "prompt_style: general",
        "provider: fake",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model",
        "algorithm:",
        "  n: 6",
        "  k: 2",
        "  t: 1",
        "  m: 4"
      ].join("\n")
    );
    const originalDir = process.env.DEEPTHONK_PROFILES_DIR;
    process.env.DEEPTHONK_PROFILES_DIR = profilesDir;
    try {
      const plan = await deepthonkPlanAsync({ profile_name: "fake-balanced" });
      expect(plan.calls).toBe(28);
    } finally {
      if (originalDir === undefined) delete process.env.DEEPTHONK_PROFILES_DIR;
      else process.env.DEEPTHONK_PROFILES_DIR = originalDir;
    }
  });

  it("rejects profile_name combined with config_path", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-profile-conflict-"));
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, "profile: quick");
    await expect(deepthonkPlanAsync({ profile_name: "anything", config_path: configPath })).rejects.toThrow(
      /profile_name and config_path cannot be used together/
    );
  });

  it("plans from config_path with algorithm overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-plan-"));
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, ["profile: paper", "algorithm:", "  n: 8", "  k: 2", "  t: 1", "  m: 4"].join("\n"));
    const plan = await deepthonkPlanAsync({ config_path: configPath });
    expect(plan.profile).toBe("custom");
    expect(plan.calls).toBe(38);
  });

  it("validates HTTP Host allowlist before transport handling", () => {
    expect(isAllowedMcpHttpHost("127.0.0.1:3333", ["127.0.0.1:3333", "localhost:3333"])).toBe(true);
    expect(isAllowedMcpHttpHost("evil.example:3333", ["127.0.0.1:3333", "localhost:3333"])).toBe(false);
  });

  it("does not advertise deferred MCP Sampling as a provider", () => {
    expect(runArgsSchema.safeParse({ task: "toy", provider: "sampling" }).success).toBe(false);
    expect(runArgsSchema.safeParse({ task: "toy", provider: "openrouter" }).success).toBe(true);
  });

  it("describes per-phase prompt variables in MCP JSON schemas", () => {
    expect(promptPhaseDescription(runArgsSchema, "compare")).toBe(
      "Variables: {task}, {rubric}, {candidateA}, {candidateB}. Output must be strict JSON: {feedback_a, feedback_b, winner: A|B|tie}."
    );
    expect(promptPhaseDescription(runArgsSchema, "mutate")).toBe("Variables: {task}, {rubric}, {candidate}, {critique}");
    expect(promptPhaseDescription(rankArgsSchema, "compare")).toBe(
      "Variables: {task}, {rubric}, {candidateA}, {candidateB}. Output must be strict JSON: {feedback_a, feedback_b, winner: A|B|tie}."
    );
    expect(promptPhaseDescription(mutateArgsSchema, "mutate")).toBe("Variables: {task}, {rubric}, {candidate}, {critique}");
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

  it("accepts inline algorithm-shape overrides via deepthonk.run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-overrides-"));
    const result = await deepthonkRun({
      task: "toy",
      profile: "paper",
      provider: "fake",
      n: 8,
      k: 2,
      t: 1,
      m: 4,
      lambda: 0.05,
      sample_temperature: 1.2,
      run_dir: runDir
    });
    expect(result.winner_id).toBeTruthy();
    const config = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as { profile: { n: number; k: number; t: number; m: number; lambda: number; sampleTemperature: number } };
    expect(config.profile.n).toBe(8);
    expect(config.profile.k).toBe(2);
    expect(config.profile.t).toBe(1);
    expect(config.profile.m).toBe(4);
    expect(config.profile.lambda).toBe(0.05);
    expect(config.profile.sampleTemperature).toBe(1.2);
  });

  it("accepts inline prompt overrides via deepthonk.run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-prompts-"));
    await deepthonkRun({
      task: "draft a counter-offer clause",
      profile: "quick",
      provider: "fake",
      run_dir: runDir,
      prompts: {
        generate: {
          system: "You are an experienced contracts attorney.",
          user: "TASK:\n{task}\n\nProduce one drafted clause."
        }
      }
    });
    // Override should be recorded in the stored config
    const config = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as {
      promptOverrides?: { generate?: { system?: string } };
    };
    expect(config.promptOverrides?.generate?.system).toContain("contracts attorney");
  });

  it("accepts inline prompt_style override via deepthonk.run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-style-"));
    await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "fake",
      prompt_style: "paper-programming",
      run_dir: runDir
    });
    const config = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as { promptStyle: string };
    expect(config.promptStyle).toBe("paper-programming");
  });

  it("rejects unknown variables in prompt overrides at run-start", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-bad-vars-"));
    await expect(
      deepthonkRun({
        task: "toy",
        profile: "quick",
        provider: "fake",
        run_dir: runDir,
        prompts: { generate: { user: "Try: {candiate}" } }
      })
    ).rejects.toThrow(/Unknown template variable.*candiate/);
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

function promptPhaseDescription(schema: Parameters<typeof zodToJsonSchema>[0], phase: string): unknown {
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" }) as JsonObject;
  const prompts = jsonSchema.properties?.prompts as JsonObject | undefined;
  const promptProperties = prompts?.properties as Record<string, JsonObject> | undefined;
  return promptProperties?.[phase]?.description;
}

interface JsonObject {
  properties?: Record<string, unknown>;
  description?: string;
}
