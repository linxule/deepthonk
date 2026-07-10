import { execFile } from "node:child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectResumeState, exportRun, listRunRecords, recordRunIndex } from "@deepthonk/core";

describe("run artifacts", () => {
  it("exports run formats and detects resume state", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-artifacts-"));
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "run_1", winner_id: "c1", calls: 3 }), "utf8");
    await writeFile(join(runDir, "events.jsonl"), "{\"type\":\"run.started\"}\n", "utf8");
    await writeFile(join(runDir, "candidates.jsonl"), "{\"id\":\"c1\"}\n", "utf8");

    expect(await detectResumeState(runDir)).toMatchObject({ status: "completed" });
    expect(await exportRun(runDir, "json")).toMatchObject({ run_id: "run_1" });
    expect(await exportRun(runDir, "jsonl")).toMatchObject({ jsonl: expect.stringContaining("run.started") });
    expect(await exportRun(runDir, "markdown")).toMatchObject({ markdown: expect.stringContaining("DeepThonk Run run_1") });
  });

  it("does not report terminal summary artifacts while run.lock is held", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-artifacts-terminal-lock-"));
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "run_locked" }), "utf8");
    await writeFile(join(runDir, "status.json"), JSON.stringify({ state: "completed", phase: "summary", run_id: "run_locked" }), "utf8");
    await writeFile(join(runDir, "run.lock"), "held\n", "utf8");

    expect(await detectResumeState(runDir)).toMatchObject({ status: "running", run_id: "run_locked", safe_to_continue: false });
    await unlink(join(runDir, "run.lock"));
    expect(await detectResumeState(runDir)).toMatchObject({ status: "completed", run_id: "run_locked" });
  });

  it("lists indexed absolute run directories", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "deepthonk-runs-root-"));
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-indexed-run-"));
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "run_indexed" }), "utf8");
    await recordRunIndex("run_indexed", runDir, runsRoot);

    expect(await listRunRecords(runsRoot)).toEqual([{ run_id: "run_indexed", run_dir: runDir }]);
  });

  it("keeps valid index rows visible across malformed rows and rejects ID remaps", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "deepthonk-resilient-index-"));
    const firstDir = join(runsRoot, "first");
    const secondDir = join(runsRoot, "second");
    await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
    await Promise.all([
      writeFile(join(firstDir, "summary.json"), JSON.stringify({ run_id: "run_first" }), "utf8"),
      writeFile(join(secondDir, "summary.json"), JSON.stringify({ run_id: "run_second" }), "utf8")
    ]);
    await writeFile(
      join(runsRoot, "index.jsonl"),
      `${JSON.stringify({ run_id: "run_first", run_dir: firstDir })}\n{broken-json\n${JSON.stringify({ run_id: "run_second", run_dir: secondDir })}\n`,
      "utf8"
    );

    expect(await listRunRecords(runsRoot)).toEqual([
      { run_id: "run_first", run_dir: firstDir },
      { run_id: "run_second", run_dir: secondDir }
    ]);
    await expect(recordRunIndex("run_first", secondDir, runsRoot)).rejects.toMatchObject({ code: "run.index_conflict" });
  });

  it("serializes index appends across child processes", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "deepthonk-cross-process-index-"));
    const coreUrl = new URL("../../packages/core/src/index.ts", import.meta.url).href;
    const runs = Array.from({ length: 12 }, (_, index) => ({
      runId: `child_${index}`,
      runDir: join(runsRoot, `child_${index}`)
    }));
    await Promise.all(
      runs.map(async ({ runId, runDir }) => {
        await mkdir(runDir);
        await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: runId }), "utf8");
      })
    );
    await Promise.all(
      runs.map(({ runId, runDir }) =>
        execFilePromise(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { recordRunIndex } from ${JSON.stringify(coreUrl)}; await recordRunIndex(${JSON.stringify(runId)}, ${JSON.stringify(runDir)}, ${JSON.stringify(runsRoot)});`
        ])
      )
    );

    expect(await listRunRecords(runsRoot)).toEqual(
      runs.map(({ runId, runDir }) => ({ run_id: runId, run_dir: runDir })).sort((left, right) => left.run_id.localeCompare(right.run_id))
    );
  });

  it("recovers an index writer lock owned by a dead same-host process", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "deepthonk-stale-index-lock-"));
    const runDir = join(runsRoot, "recovered");
    await mkdir(runDir);
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "recovered" }), "utf8");
    await writeFile(
      join(runsRoot, "index.jsonl.lock"),
      `${JSON.stringify({
        schema_version: 1,
        claim_id: "stale-index-owner",
        hostname: hostname(),
        worker_pid: 2_147_483_647,
        claimed_at: new Date().toISOString()
      })}\n`,
      "utf8"
    );
    await expect(recordRunIndex("recovered", runDir, runsRoot)).resolves.toBeUndefined();
    expect(await listRunRecords(runsRoot)).toContainEqual({ run_id: "recovered", run_dir: runDir });
  });
});

function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: process.cwd() }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve();
    });
  });
}
