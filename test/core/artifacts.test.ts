import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("lists indexed absolute run directories", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "deepthonk-runs-root-"));
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-indexed-run-"));
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "run_indexed" }), "utf8");
    await recordRunIndex("run_indexed", runDir, runsRoot);

    expect(await listRunRecords(runsRoot)).toEqual([{ run_id: "run_indexed", run_dir: runDir }]);
  });
});
