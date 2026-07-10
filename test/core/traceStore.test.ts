import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { builtInProfiles, runCheckpointedPhase, TraceStore, type RunConfig } from "@deepthonk/core";

describe("TraceStore batching and prompt blobs", () => {
  it("batches concurrently-ready JSONL rows into at least 70% fewer append writes", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-trace-batch-"));
    const trace = new TraceStore(runDir);
    await trace.init(config(runDir), "batch-run");
    const before = trace.metrics();
    const rows = 100;
    await Promise.all(Array.from({ length: rows }, (_, index) => trace.event({ type: "batch.test", index })));
    await trace.flush();
    const after = trace.metrics();
    const appendWrites = after.appendWrites - before.appendWrites;
    expect(after.appendRows - before.appendRows).toBe(rows);
    expect(appendWrites).toBeLessThanOrEqual(rows * 0.3);
    await trace.close();
    expect((await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(rows + 1);
  });

  it("stores prompts by digest and rejects caller-controlled reference paths", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-prompt-cas-"));
    const trace = new TraceStore(runDir);
    const prompt = { system: "system prompt", user: "user prompt" };
    const first = await trace.writePrompt(prompt);
    const repeated = await trace.writePrompt(prompt);
    expect(repeated).toEqual(first);
    await expect(trace.readPrompt(first)).resolves.toEqual(prompt);
    await expect(trace.readPrompt({ ...first, path: "config.json" })).rejects.toThrow(/path does not match/i);
    await expect(trace.init(config(runDir), "not-fresh")).rejects.toThrow(/artifacts\/prompts/);
  });

  it("re-materializes reused checkpoint receipts with bounded batching", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-trace-reuse-batch-"));
    const trace = new TraceStore(runDir);
    await trace.init(config(runDir), "receipt-batch-run");
    const jobs = Array.from({ length: 100 }, (_, index) => ({
      id: `work-${index}`,
      input: { index },
      run: async () => ({ index })
    }));
    await runCheckpointedPhase({ runDir, phaseKey: "batch-receipts", jobs, concurrency: 1 });
    const before = trace.metrics();
    await runCheckpointedPhase({
      runDir,
      phaseKey: "batch-receipts",
      jobs: jobs.map((job) => ({
        ...job,
        run: async (): Promise<{ index: number }> => {
          throw new Error("receipt should be reused");
        }
      })),
      concurrency: 1,
      onResult: async (output) => trace.event({ type: "receipt.reused", index: output.index })
    });
    await trace.flush();
    const after = trace.metrics();
    expect(after.appendRows - before.appendRows).toBe(100);
    expect(after.appendWrites - before.appendWrites).toBeLessThanOrEqual(30);
    await trace.close();
  });

  it("closes and evicts an open append handle after append failure", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-trace-append-failure-"));
    const trace = new TraceStore(runDir);
    await trace.init(config(runDir), "append-failure-run");
    const handles = (trace as unknown as { appendHandles: Map<string, Promise<{ appendFile: (...args: unknown[]) => Promise<void>; close: () => Promise<void> }>> })
      .appendHandles;
    const handle = await handles.get("events.jsonl")!;
    const failure = new Error("injected append failure");
    vi.spyOn(handle, "appendFile").mockRejectedValueOnce(failure);
    const close = vi.spyOn(handle, "close");

    await expect(trace.event({ type: "append.failure" })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(handles.has("events.jsonl")).toBe(false);

    await expect(trace.event({ type: "append.recovered" })).resolves.toBeUndefined();
    await trace.close();
  });
});

function config(runDir: string): RunConfig {
  return {
    task: "trace test",
    profile: builtInProfiles.quick,
    runDir,
    seed: 1,
    provider: "fake",
    generatorModel: "fake-model",
    mutatorModel: "fake-model",
    judgeModel: "fake-model",
    concurrency: { generate: 1, judge: 1, mutate: 1 },
    retry: { httpRetries: 0, invalidJsonRetries: 1 },
    output: { includeRawModelOutputs: false, includePrompts: false }
  };
}
