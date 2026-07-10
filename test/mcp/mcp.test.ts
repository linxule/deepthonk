import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  deepthonkCancel,
  deepthonkLockInspect,
  deepthonkLockReclaim,
  deepthonkRepairBudget,
  deepthonkPlan,
  deepthonkPlanAsync,
  deepthonkResult,
  deepthonkRank,
  deepthonkRun,
  deepthonkStart,
  deepthonkStatus,
  deepthonkProfileList,
  deepthonkProfileSave,
  deepthonkProfileShow,
  statusOutputSchema,
  isAllowedLoopbackOrigin,
  isAllowedMcpHttpHost,
  isAllowedSecFetchSite,
  isApplicationJsonContentType,
  BackgroundJobManager,
  createMcpHttpServer,
  listRunResources,
  promptNames,
  readJobResource,
  readRunResource,
  resourceTemplates,
  mutateArgsSchema,
  rankArgsSchema,
  runArgsSchema,
  toolError,
  toolNames
} from "@deepthonk/mcp";

describe("MCP helpers", () => {
  it("lists expected surfaces", () => {
    expect(toolNames).toContain("deepthonk.plan");
    expect(toolNames).toContain("deepthonk.start");
    expect(toolNames).toContain("deepthonk.status");
    expect(toolNames).toContain("deepthonk.result");
    expect(toolNames).toContain("deepthonk.cancel");
    expect(toolNames).toContain("deepthonk.lock_inspect");
    expect(toolNames).toContain("deepthonk.lock_reclaim");
    expect(toolNames).toContain("deepthonk.repair_budget");
    expect(toolNames).toContain("deepthonk.profile_list");
    expect(toolNames).toContain("deepthonk.profile_show");
    expect(toolNames).toContain("deepthonk.profile_save");
    expect(toolNames).toContain("deepthonk.profile_delete");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/summary");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/usage");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/population/{generation}");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/{resource}/page/{cursor}");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/prompts/{sha256}");
    expect(resourceTemplates).toContain("deepthonk://runs/{run_id}/trace-v2/checkpoints/{phase_id}/{checkpoint_id}");
    expect(resourceTemplates).toContain("deepthonk://jobs/{job_id}/config");
    expect(resourceTemplates).toContain("deepthonk://jobs/{job_id}/population/{generation}");
    expect(promptNames).toContain("deepthonk/compare");
  });

  it("returns MCP tool errors as JSON text without structuredContent", () => {
    const result = toolError(new Error("boom"));
    expect(result).not.toHaveProperty("structuredContent");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: "unexpected_error", message: "boom" });
  });

  it("runs background jobs FIFO with two active slots and bounded reservations", async () => {
    expect(new BackgroundJobManager(1, 1).stats()).toMatchObject({ maxActive: 1, maxQueued: 1 });
    expect(() => new BackgroundJobManager(0, 1)).toThrow(/maxActive/);
    expect(() => new BackgroundJobManager(1, -1)).toThrow(/maxQueued/);
    const manager = new BackgroundJobManager(2, 2);
    const reservations = Array.from({ length: 4 }, () => manager.reserve());
    expect(reservations.every(Boolean)).toBe(true);
    expect(manager.reserve()).toBeUndefined();

    const started: number[] = [];
    const releases: Array<() => void> = [];
    const task = (id: number) => () => new Promise<void>((resolve) => {
      started.push(id);
      releases[id] = resolve;
    });
    reservations.forEach((reservation, id) => manager.schedule(reservation!, task(id)));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    releases[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    releases[1]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2, 3]);
    releases[2]!();
    releases[3]!();
  });

  it("inspects and reclaims locks only with the exact fingerprint", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-lock-"));
    await writeFile(join(runDir, "run.lock"), "malformed lock\n");
    const inspected = await deepthonkLockInspect({ run_dir: runDir });
    expect(inspected).toMatchObject({ state: "malformed", run_dir: runDir });
    expect(await deepthonkLockReclaim({ run_dir: runDir, fingerprint: `sha256:${"0".repeat(64)}` })).toMatchObject({ reclaimed: false });
    expect(await deepthonkLockReclaim({ run_dir: runDir, fingerprint: inspected.fingerprint })).toMatchObject({ reclaimed: true });
    await expect(readFile(join(runDir, "run.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs legacy-redacted budgets through the MCP surface", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-budget-repair-"));
    await writeFile(join(runDir, "config.json"), JSON.stringify({ budget: { maxOutputTokens: "[redacted]" } }));
    await expect(deepthonkRepairBudget({
      run_dir: runDir,
      replacements: { "budget.maxOutputTokens": 4096 }
    })).resolves.toEqual({ run_dir: runDir, repaired: ["budget.maxOutputTokens"] });
  });

  it("pages resources over 1 MiB with opaque bounded cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-pages-"));
    const runId = "large-run";
    const runDir = join(root, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), `${JSON.stringify({ run_id: runId })}\n`);
    const rows = Array.from({ length: 1_200 }, (_, index) => JSON.stringify({ index, text: "x".repeat(900) })).join("\n") + "\n";
    await writeFile(join(runDir, "candidates.jsonl"), rows);

    let firstPageUri = "";
    await expect(readRunResource(`deepthonk://runs/${runId}/candidates`, root)).rejects.toSatisfy((error: unknown) => {
      const fix = (error as { fix?: string }).fix ?? "";
      firstPageUri = fix.match(/deepthonk:\/\/\S+/)?.[0] ?? "";
      return (error as { code?: string }).code === "mcp.resource_too_large" && firstPageUri.length > 0;
    });
    expect(firstPageUri).not.toContain("/page/0");
    const pageText = await readRunResource(firstPageUri, root);
    const page = JSON.parse(pageText) as { records: unknown[]; next_cursor?: string };
    expect(page.records.length).toBeLessThanOrEqual(1_000);
    expect(Buffer.byteLength(pageText, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(page.next_cursor).toBeTruthy();

    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: runId, blob: "x".repeat(1_100_000) }));
    let summaryPageUri = "";
    await expect(readRunResource(`deepthonk://runs/${runId}/summary`, root)).rejects.toSatisfy((error: unknown) => {
      summaryPageUri = ((error as { fix?: string }).fix ?? "").match(/deepthonk:\/\/\S+/)?.[0] ?? "";
      return (error as { code?: string }).code === "mcp.resource_too_large";
    });
    const summaryPageText = await readRunResource(summaryPageUri, root);
    const summaryPage = JSON.parse(summaryPageText) as { encoding: string; data: string; next_cursor?: string };
    expect(summaryPage.encoding).toBe("base64");
    expect(Buffer.from(summaryPage.data, "base64").toString("utf8")).toContain(`{"run_id":"${runId}"`);
    expect(Buffer.byteLength(summaryPageText, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(summaryPage.next_cursor).toBeTruthy();
  });

  it("reads content-addressed prompts by verified hash and pages them without accepting paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-prompt-resource-"));
    const runId = "prompt-resource-run";
    const runDir = join(root, runId);
    const promptDir = join(runDir, "artifacts", "prompts");
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: runId }));

    const small = `${JSON.stringify({ system: "system", user: "user" }, null, 2)}\n`;
    const smallSha = `sha256:${createHash("sha256").update(small).digest("hex")}`;
    await writeFile(join(promptDir, `${smallSha.slice("sha256:".length)}.json`), small);
    const smallUri = `deepthonk://runs/${runId}/prompts/${encodeURIComponent(smallSha)}?path=../../ignored`;
    await expect(readRunResource(smallUri, root)).resolves.toBe(small);
    await expect(readRunResource(`deepthonk://runs/${runId}/prompts/${encodeURIComponent("../secret")}`, root)).rejects.toMatchObject({
      code: "mcp.invalid_prompt_hash"
    });

    const wrongSha = `sha256:${"f".repeat(64)}`;
    await writeFile(join(promptDir, `${"f".repeat(64)}.json`), small);
    await expect(readRunResource(`deepthonk://runs/${runId}/prompts/${encodeURIComponent(wrongSha)}`, root)).rejects.toMatchObject({
      code: "mcp.prompt_hash_mismatch"
    });

    const large = `${JSON.stringify({ system: "system", user: "x".repeat(1_100_000) })}\n`;
    const largeSha = `sha256:${createHash("sha256").update(large).digest("hex")}`;
    await writeFile(join(promptDir, `${largeSha.slice("sha256:".length)}.json`), large);
    const jobId = "job-prompt-resource";
    await writeFile(join(runDir, "status.json"), JSON.stringify({ job_id: jobId, run_dir: runDir, state: "completed" }));
    const jobUri = `deepthonk://jobs/${jobId}/prompts/${encodeURIComponent(largeSha)}?run_dir=${encodeURIComponent(runDir)}`;
    let firstPage = "";
    await expect(readJobResource(jobUri)).rejects.toSatisfy((error: unknown) => {
      firstPage = ((error as { fix?: string }).fix ?? "").match(/deepthonk:\/\/\S+/)?.[0] ?? "";
      return (error as { code?: string }).code === "mcp.resource_too_large" && firstPage.includes("/page/");
    });
    const pageText = await readJobResource(firstPage);
    const page = JSON.parse(pageText) as { encoding: string; data: string; next_cursor?: string };
    expect(page.encoding).toBe("base64");
    expect(page.data.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(pageText, "utf8")).toBeLessThanOrEqual(1_000_000);
  });

  it("discovers and safely reads every trace-v2 manifest, commit, and checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-trace-v2-resource-"));
    const runId = "trace-v2-resource-run";
    const runDir = join(root, runId);
    const phaseId = "generation_judging_3A1";
    const checkpointDir = join(runDir, "checkpoints", phaseId);
    await mkdir(join(runDir, "manifests"), { recursive: true });
    await mkdir(join(runDir, "commits"), { recursive: true });
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: runId }));
    await writeFile(join(runDir, "manifests", `${phaseId}.json`), JSON.stringify({ schema_version: 2, phase_key: "generation_judging:1" }));
    await writeFile(join(runDir, "commits", `${phaseId}.json`), JSON.stringify({ schema_version: 2, phase_key: "generation_judging:1" }));
    for (let index = 0; index < 1_001; index += 1) {
      const checkpointId = index.toString(16).padStart(64, "0");
      await writeFile(join(checkpointDir, `${checkpointId}.json`), JSON.stringify({ schema_version: 2, index }));
    }

    const traceIndex = JSON.parse(await readRunResource(`deepthonk://runs/${runId}/trace-v2`, root)) as {
      records: Array<{ phase_id: string; manifest_uri: string; commit_uri: string; checkpoints_uri: string }>;
    };
    expect(traceIndex.records).toHaveLength(1);
    expect(JSON.parse(await readRunResource(traceIndex.records[0].manifest_uri, root))).toMatchObject({ schema_version: 2 });
    expect(JSON.parse(await readRunResource(traceIndex.records[0].commit_uri, root))).toMatchObject({ schema_version: 2 });

    const checkpointIndex = JSON.parse(await readRunResource(traceIndex.records[0].checkpoints_uri, root)) as {
      records: Array<{ checkpoint_id: string; uri: string }>;
      next_cursor?: string;
    };
    expect(checkpointIndex.records).toHaveLength(1_000);
    expect(checkpointIndex.next_cursor).toBeTruthy();
    expect(checkpointIndex.next_cursor).not.toBe("1000");
    expect(JSON.parse(await readRunResource(checkpointIndex.records[0].uri, root))).toMatchObject({ schema_version: 2 });
    const secondPage = JSON.parse(await readRunResource(
      `deepthonk://runs/${runId}/trace-v2/checkpoints/${phaseId}/page/${checkpointIndex.next_cursor}`,
      root
    )) as { records: unknown[] };
    expect(secondPage.records).toHaveLength(1);

    await expect(readRunResource(
      `deepthonk://runs/${runId}/trace-v2/manifests/${encodeURIComponent("../escape")}`,
      root
    )).rejects.toMatchObject({ code: "mcp.invalid_trace_phase" });
    await expect(readRunResource(
      `deepthonk://runs/${runId}/trace-v2/checkpoints/${phaseId}/${encodeURIComponent("../escape")}`,
      root
    )).rejects.toMatchObject({ code: "mcp.invalid_checkpoint_id" });

    const jobId = "job-trace-v2-resource";
    await writeFile(join(runDir, "status.json"), JSON.stringify({ job_id: jobId, run_dir: runDir, state: "completed" }));
    const jobIndex = JSON.parse(await readJobResource(
      `deepthonk://jobs/${jobId}/trace-v2?run_dir=${encodeURIComponent(runDir)}`
    )) as { records: Array<{ manifest_uri: string }> };
    expect(jobIndex.records[0].manifest_uri).toContain("run_dir=");
    await expect(readJobResource(jobIndex.records[0].manifest_uri)).resolves.toContain("generation_judging:1");
  });

  it("refuses job resources without the exact recorded job ID and run directory pair", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-unowned-job-"));
    await writeFile(join(runDir, "config.json"), '{"not":"a job"}\n');
    const uri = `deepthonk://jobs/forged/config?run_dir=${encodeURIComponent(runDir)}`;
    await expect(readJobResource(uri)).rejects.toMatchObject({ code: "mcp.job_mismatch" });
  });

  it.each(["..", ".", "%2e%2e", "bad%2Fid", "bad\\id"])("rejects path-shaped run IDs in resources: %s", async (runId) => {
    await expect(readRunResource(`deepthonk://runs/${runId}/summary`)).rejects.toMatchObject({ code: "mcp.invalid_run_id" });
  });

  it("keeps Streamable HTTP state across requests and closes it with DELETE", async () => {
    const httpServer = createMcpHttpServer({ port: 0, sessionIdleMs: 60_000, maxSessions: 2 });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const initialized = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }
        })
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const sessionHeaders = { ...headers, "mcp-session-id": sessionId! };
      await fetch(url, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      });
      const listed = await fetch(url, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      });
      expect(listed.status).toBe(200);
      expect(await listed.text()).toContain("deepthonk.run");
      expect((await fetch(url, { method: "DELETE", headers: sessionHeaders })).status).toBe(200);
      expect((await fetch(url, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
      })).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("reads prompt and trace-v2 resources through the official Streamable HTTP SDK client", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-sdk-resource-read-"));
    const jobId = "job-sdk-resource-read";
    const promptDir = join(runDir, "artifacts", "prompts");
    await mkdir(promptDir, { recursive: true });
    await mkdir(join(runDir, "manifests"), { recursive: true });
    const prompt = `${JSON.stringify({ system: "sdk", user: "resource" })}\n`;
    const sha256 = `sha256:${createHash("sha256").update(prompt).digest("hex")}`;
    await writeFile(join(promptDir, `${sha256.slice("sha256:".length)}.json`), prompt);
    await writeFile(join(runDir, "manifests", "initial_generation.json"), JSON.stringify({ schema_version: 2, phase_key: "initial_generation" }));
    await writeFile(join(runDir, "status.json"), JSON.stringify({ job_id: jobId, run_dir: runDir, state: "completed" }));

    const httpServer = createMcpHttpServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = new Client({ name: "deepthonk-resource-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const promptUri = `deepthonk://jobs/${jobId}/prompts/${encodeURIComponent(sha256)}?run_dir=${encodeURIComponent(runDir)}`;
      const promptResult = await client.readResource({ uri: promptUri });
      expect(promptResult.contents[0]).toMatchObject({ mimeType: "application/json", text: prompt });

      const traceUri = `deepthonk://jobs/${jobId}/trace-v2?run_dir=${encodeURIComponent(runDir)}`;
      const traceResult = await client.readResource({ uri: traceUri });
      expect(JSON.parse((traceResult.contents[0] as { text: string }).text).records).toEqual([
        expect.objectContaining({ phase_id: "initial_generation" })
      ]);
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain(
        "deepthonk://jobs/{job_id}/prompts/{sha256}"
      );
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain(
        "deepthonk://jobs/{job_id}/trace-v2/checkpoints/{phase_id}/{checkpoint_id}"
      );
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
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
    const artifactResources = started.artifact_resources as Record<string, string>;
    expect(artifactResources.status).toBe(started.status_resource);
    expect(artifactResources.result).toBe(started.result_resource);
    expect(artifactResources.config).toContain("deepthonk://jobs/");
    expect(artifactResources.prompt_template).toContain("/prompts/{sha256}");
    await expect(readJobResource(artifactResources.status)).resolves.toContain(String(started.job_id));
    let result = await deepthonkResult({ run_dir: runDir });
    for (let attempt = 0; attempt < 100 && !result.complete; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await deepthonkResult({ run_dir: runDir });
    }
    expect(result.complete).toBe(true);
    expect(result.run_id).toBeTruthy();
    const status = await deepthonkStatus({ run_dir: runDir });
    expect(status.state).toBe("completed");
    await expect(readJobResource(artifactResources.config)).resolves.toContain("\"provider\": \"fake\"");
    await expect(readJobResource(artifactResources.candidates)).resolves.toContain("\"kind\"");
    await expect(readJobResource(artifactResources.population_template.replace("{generation}", "0"))).resolves.toContain("\"kind\"");
    expect(await readdir(runDir)).not.toContain("run.lock");
    await expect(deepthonkStatus({ run_dir: runDir, job_id: "wrong-job" })).rejects.toMatchObject({ code: "mcp.job_mismatch" });
  });

  it("marks background provider construction failures and releases run.lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-driver-fail-"));
    const missingEnv = `DEEPTHONK_TEST_MISSING_${Date.now()}`;
    delete process.env[missingEnv];
    const started = await deepthonkStart({
      task: "toy",
      profile: "quick",
      provider: "custom-openai-compatible",
      base_url: "https://example.test/v1",
      api_key_env: missingEnv,
      run_dir: runDir
    });
    expect(started.state).toBe("pending");

    let status = await deepthonkStatus({ run_dir: runDir });
    for (let attempt = 0; attempt < 100 && status.state !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await deepthonkStatus({ run_dir: runDir });
    }

    expect(status.state).toBe("failed");
    expect((status.error as { code?: string } | undefined)?.code).toBe("provider.missing_api_key");
    expect(await readdir(runDir)).not.toContain("run.lock");
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
    await expect(listRunResources(join(runDir, ".."))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: `deepthonk://runs/${String(result.run_id)}/population/0`,
          mimeType: "application/json"
        })
      ])
    );
    const listedResources = await listRunResources(join(runDir, ".."));
    expect(new Set(listedResources.map((resource) => resource.uri)).size).toBe(listedResources.length);
  });

  it("honors a validated caller-supplied run_id", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-run-id-"));
    const runId = `caller.run_${Date.now()}`;
    const result = await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "fake",
      run_id: runId,
      run_dir: runDir
    });
    expect(result.run_id).toBe(runId);
    expect(JSON.parse(await readFile(join(runDir, "config.json"), "utf8"))).toMatchObject({ runId });
    expect(() => runArgsSchema.parse({ task: "toy", provider: "fake", run_id: "../escape" })).toThrow();
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

  it("lists named profiles through profile_list", async () => {
    await withProfilesDir(async (profilesDir) => {
      await writeFile(join(profilesDir, "alpha.yaml"), validMcpProfileYaml());
      await writeFile(join(profilesDir, "beta.yaml"), validMcpProfileYaml());
      await expect(deepthonkProfileList({})).resolves.toEqual({ profiles: ["alpha", "beta"] });
    });
  });

  it("saves a named profile through profile_save and lists it", async () => {
    await withProfilesDir(async (profilesDir) => {
      const saved = await deepthonkProfileSave(validMcpProfileArgs("round-trip"));
      expect(saved.path).toBe(join(profilesDir, "round-trip.yaml"));
      expect(await readFile(String(saved.path), "utf8")).toContain("prompt_style: general");
      await expect(deepthonkProfileList({})).resolves.toEqual({ profiles: ["round-trip"] });
    });
  });

  it("shows valid named profiles with api_key_env visible", async () => {
    await withProfilesDir(async (profilesDir) => {
      await writeFile(join(profilesDir, "valid.yaml"), validMcpProfileYaml());
      const shown = await deepthonkProfileShow({ name: "valid" });
      expect((shown.profile as { api_key_env?: string }).api_key_env).toBe("DEEPTHONK_API_KEY");
    });
  });

  it("rejects manually edited named profiles with secret-shaped fields on load", async () => {
    await withProfilesDir(async (profilesDir) => {
      await writeFile(
        join(profilesDir, "with-redaction.yaml"),
        [
          validMcpProfileYaml(),
          "providers:",
          "  judge:",
          "    provider: fake",
          "    model: fake-model",
          "    authorization: Bearer raw-secret"
        ].join("\n")
      );
      await expect(deepthonkProfileShow({ name: "with-redaction" })).rejects.toMatchObject({ code: "config.profile_raw_secret" });
    });
  });

  it("refuses raw api_key in profile_save payloads", async () => {
    await withProfilesDir(async () => {
      await expect(
        deepthonkProfileSave({
          ...validMcpProfileArgs("bad-secret"),
          api_key: "raw-secret"
        })
      ).rejects.toMatchObject({ code: "config.profile_raw_api_key" });
    });
  });

  it("rejects unknown top-level profile_save arguments", async () => {
    await withProfilesDir(async () => {
      await expect(
        deepthonkProfileSave({
          ...validMcpProfileArgs("unknown-field"),
          mystery_field: "x"
        })
      ).rejects.toMatchObject({
        code: "mcp.invalid_arguments",
        message: expect.stringContaining("mystery_field")
      });
    });
  });

  it("rejects secret-shaped fields in profile_save payloads", async () => {
    await withProfilesDir(async () => {
      await expect(
        deepthonkProfileSave({
          ...validMcpProfileArgs("prompt-password"),
          prompts: {
            generate: {
              system: "s",
              password: "x"
            }
          }
        })
      ).rejects.toMatchObject({ code: "config.profile_raw_secret" });

      for (const key of ["authorization", "token", "secret", "password", "bearer", "cookie", "credential"]) {
        await expect(
          deepthonkProfileSave({
            ...validMcpProfileArgs(`bad-${key}`),
            algorithm: { [key]: "raw-secret" }
          })
        ).rejects.toMatchObject({
          code: "config.profile_raw_secret",
          message: expect.stringContaining(key)
        });
      }
    });
  });

  it("does not leave validation temp files when profile_save validation fails", async () => {
    await withProfilesDir(async (profilesDir) => {
      await expect(
        deepthonkProfileSave({
          name: "invalid",
          profile: "quick",
          prompt_style: "general",
          models: {
            generator: "fake-model",
            mutator: "fake-model",
            judge: "fake-model"
          }
        })
      ).rejects.toMatchObject({ code: "config.profile_missing_fields" });

      expect(await readdir(profilesDir)).toEqual([]);
    });
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

  it("validates HTTP pre-body request guards", () => {
    expect(isApplicationJsonContentType("application/json")).toBe(true);
    expect(isApplicationJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isApplicationJsonContentType("text/plain")).toBe(false);
    expect(isApplicationJsonContentType(undefined)).toBe(false);

    expect(isAllowedLoopbackOrigin(undefined)).toBe(true);
    expect(isAllowedLoopbackOrigin("http://127.0.0.1:3333")).toBe(true);
    expect(isAllowedLoopbackOrigin("http://localhost:3333")).toBe(true);
    expect(isAllowedLoopbackOrigin("https://evil.example")).toBe(false);
    expect(isAllowedLoopbackOrigin("null")).toBe(false);

    expect(isAllowedSecFetchSite(undefined)).toBe(true);
    expect(isAllowedSecFetchSite("same-origin")).toBe(true);
    expect(isAllowedSecFetchSite("cross-site")).toBe(false);
  });

  it("accepts MCP Sampling provider args and enforces client capability at run-start", async () => {
    expect(runArgsSchema.safeParse({ task: "toy", provider: "sampling" }).success).toBe(true);
    expect(runArgsSchema.safeParse({ task: "toy", provider: "openrouter" }).success).toBe(true);
    await expect(
      deepthonkRun(
        { task: "toy", provider: "sampling" },
        {
          getClientCapabilities: () => ({}),
          createMessage: async () => ({
            model: "unused",
            role: "assistant",
            content: { type: "text", text: "unused" }
          })
        }
      )
    ).rejects.toMatchObject({ code: "provider.sampling_capability_missing" });
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

  it("isolates a replaced role route from base model, credential, and JSON-mode settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-role-isolation-"));
    const configPath = join(root, "config.yaml");
    const runDir = join(root, "run");
    await writeFile(configPath, [
      "profile: quick",
      "provider: fake",
      "api_key_env: STALE_BASE_KEY",
      "supports_json_mode: false",
      "models:",
      "  generator: stale-generator",
      "  mutator: stale-mutator",
      "  judge: stale-judge",
      "providers:",
      "  judge:",
      "    provider: fake",
      "    base_url: https://judge.example.test/v1"
    ].join("\n"));

    await deepthonkRun({ task: "toy", config_path: configPath, run_dir: runDir });
    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as {
      providerReplay?: { roleProviders?: { judge?: { model?: string; apiKeyEnv?: string; supportsJsonMode?: boolean } } };
    };
    expect(stored.providerReplay?.roleProviders?.judge).toMatchObject({ model: "fake-model" });
    expect(stored.providerReplay?.roleProviders?.judge).not.toHaveProperty("apiKeyEnv");
    expect(stored.providerReplay?.roleProviders?.judge).not.toHaveProperty("supportsJsonMode");
  });

  it("rejects mixed Sampling/direct role routes with a stable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-mixed-sampling-"));
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, [
      "profile: quick",
      "provider: fake",
      "providers:",
      "  judge:",
      "    provider: sampling"
    ].join("\n"));
    await expect(deepthonkRun({ task: "toy", config_path: configPath, run_dir: join(root, "run") }, {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: async () => ({ model: "unused", role: "assistant", content: { type: "text", text: "unused" } })
    })).rejects.toMatchObject({ code: "provider.mixed_sampling_routes_unsupported", retryable: false });
  });

  it("omits oversized summaries from job result tool and resource outputs", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-large-result-"));
    const jobId = `job-large-${Date.now()}`;
    const runId = `large-result-${Date.now()}`;
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: runId, payload: "x".repeat(1_100_000) }));
    await writeFile(join(runDir, "status.json"), JSON.stringify({
      job_id: jobId,
      run_id: runId,
      run_dir: runDir,
      state: "completed",
      phase: "summary",
      usage: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      updated_at: new Date().toISOString()
    }));

    const toolOutput = await deepthonkResult({ run_dir: runDir, job_id: jobId });
    expect(toolOutput).toMatchObject({ complete: true, summary_omitted: true });
    expect(toolOutput).not.toHaveProperty("summary");
    expect(Buffer.byteLength(JSON.stringify(toolOutput), "utf8")).toBeLessThanOrEqual(1_000_000);

    const resourceText = await readJobResource(`deepthonk://jobs/${jobId}/result?run_dir=${encodeURIComponent(runDir)}`);
    expect(JSON.parse(resourceText)).toMatchObject({ complete: true, summary_omitted: true });
    expect(Buffer.byteLength(resourceText, "utf8")).toBeLessThanOrEqual(1_000_000);
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
    const result = await deepthonkRun({ task: "toy", config_path: configPath, run_dir: runDir });
    const firstCandidate = JSON.parse((await readFile(join(runDir, "candidates.jsonl"), "utf8")).trim().split("\n")[0]) as {
      metadata?: { prompt?: unknown; promptRef?: { sha256: string; path: string } };
    };
    expect(firstCandidate.metadata).not.toHaveProperty("prompt");
    const promptRef = firstCandidate.metadata?.promptRef;
    expect(promptRef?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(promptRef?.path).toBe(`artifacts/prompts/${promptRef?.sha256.slice("sha256:".length)}.json`);
    const promptText = await readRunResource(
      `deepthonk://runs/${String(result.run_id)}/prompts/${encodeURIComponent(promptRef!.sha256)}`,
      root
    );
    expect(JSON.parse(promptText)).toMatchObject({ system: expect.any(String), user: expect.stringContaining("toy") });
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

  it("persists inline v0.2 output, critique, rank, and provider limiter controls", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-v02-controls-"));
    await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "fake",
      run_dir: runDir,
      provider_max_concurrency: 3,
      model_output_tokens: { generation: 700, mutation: 701, judge: 300, finalizer: 702 },
      critique_limits: { aggregate_chars: 2_000 },
      rank: { mode: "all-pairs", seed: 19, max_calls: 100 }
    });
    const config = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      providerMaxConcurrency: 3,
      modelOutputTokens: { generation: 700, mutation: 701, judge: 300, finalizer: 702 },
      critiqueLimits: { aggregateChars: 2_000 },
      rank: { mode: "all-pairs", seed: 19, maxCalls: 100 }
    });
    expect(rankArgsSchema.safeParse({
      task: "toy",
      provider: "fake",
      candidates: ["a", "b"],
      model_output_tokens: { judge: 256 },
      provider_max_concurrency: 2,
      rank: { mode: "k-regular", k: 1, seed: 5, max_calls: 1 }
    }).success).toBe(true);
    expect(mutateArgsSchema.safeParse({
      task: "toy",
      provider: "fake",
      candidate: "a",
      critique: "improve",
      model_output_tokens: { mutation: 512 },
      provider_max_concurrency: 2
    }).success).toBe(true);

    const ranked = await deepthonkRank({
      task: "toy",
      provider: "fake",
      candidates: ["a", "b", "c", "d", "e", "f"],
      rank: { mode: "k-regular", k: 2, seed: 5, max_calls: 6 }
    });
    expect(ranked.comparisons).toHaveLength(6);
  });

  it("merges config-file v0.2 controls with field-level inline precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-v02-config-"));
    const configPath = join(root, "config.yaml");
    const runDir = join(root, "run");
    await writeFile(configPath, [
      "profile: quick",
      "provider: fake",
      "model_output_tokens:",
      "  generation: 111",
      "  mutation: 222",
      "  judge: 333",
      "  finalizer: 444",
      "critique_limits:",
      "  aggregate_chars: 1000",
      "rank:",
      "  mode: k-regular",
      "  k: 2",
      "  seed: 7",
      "  max_calls: 6",
      "provider_max_concurrency: 1"
    ].join("\n"));

    await deepthonkRun({
      task: "toy",
      config_path: configPath,
      run_dir: runDir,
      model_output_tokens: { generation: 555 },
      critique_limits: { aggregate_chars: 1500 },
      rank: { mode: "all-pairs", max_calls: 15 },
      provider_max_concurrency: 2
    });
    expect(JSON.parse(await readFile(join(runDir, "config.json"), "utf8"))).toMatchObject({
      modelOutputTokens: { generation: 555, mutation: 222, judge: 333, finalizer: 444 },
      critiqueLimits: { aggregateChars: 1500 },
      rank: { mode: "all-pairs", k: 2, seed: 7, maxCalls: 15 },
      providerMaxConcurrency: 2
    });

    const candidates = ["a", "b", "c", "d", "e", "f"];
    const fromFile = await deepthonkRank({ task: "toy", config_path: configPath, candidates });
    expect(fromFile.comparisons).toHaveLength(6);
    const inline = await deepthonkRank({
      task: "toy",
      config_path: configPath,
      candidates,
      rank: { mode: "all-pairs", max_calls: 15 }
    });
    expect(inline.comparisons).toHaveLength(15);
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

async function withProfilesDir<T>(action: (profilesDir: string) => Promise<T>): Promise<T> {
  const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-profile-tools-"));
  const originalDir = process.env.DEEPTHONK_PROFILES_DIR;
  process.env.DEEPTHONK_PROFILES_DIR = profilesDir;
  try {
    return await action(profilesDir);
  } finally {
    if (originalDir === undefined) delete process.env.DEEPTHONK_PROFILES_DIR;
    else process.env.DEEPTHONK_PROFILES_DIR = originalDir;
  }
}

function validMcpProfileArgs(name: string): Record<string, unknown> {
  return {
    name,
    profile: "quick",
    prompt_style: "general",
    provider: "fake",
    api_key_env: "DEEPTHONK_API_KEY",
    models: {
      generator: "fake-model",
      mutator: "fake-model",
      judge: "fake-model"
    }
  };
}

function validMcpProfileYaml(): string {
  return [
    "profile: quick",
    "prompt_style: general",
    "provider: fake",
    "api_key_env: DEEPTHONK_API_KEY",
    "models:",
    "  generator: fake-model",
    "  mutator: fake-model",
    "  judge: fake-model"
  ].join("\n");
}
