import { describe, expect, it } from "vitest";
import { maxPhaseConcurrency, runLimitedPhase } from "@deepthonk/core";

describe("runLimitedPhase", () => {
  it("preserves result order", async () => {
    const results = await runLimitedPhase(
      [
        async () => {
          await sleep(10);
          return "first";
        },
        async () => "second",
        async () => "third"
      ],
      3
    );

    expect(results).toEqual(["first", "second", "third"]);
  });

  it("stops queued jobs after the first failure, drains active jobs, and rethrows the original error", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const original = new Error("original failure");

    await expect(
      runLimitedPhase(
        [
          async () => {
            started.push(0);
            await sleep(20);
            finished.push(0);
            return 0;
          },
          async () => {
            started.push(1);
            throw original;
          },
          async () => {
            started.push(2);
            finished.push(2);
            return 2;
          }
        ],
        2
      )
    ).rejects.toBe(original);

    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
  });

  it("pulls 100k iterable jobs lazily with bounded outstanding work and memory", async () => {
    const jobCount = 100_000;
    const concurrency = 8;
    let pulled = 0;
    let completed = 0;
    let active = 0;
    let maxActive = 0;
    let maxOutstanding = 0;
    function* jobs() {
      for (let index = 0; index < jobCount; index += 1) {
        pulled += 1;
        maxOutstanding = Math.max(maxOutstanding, pulled - completed);
        yield async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          completed += 1;
          return index;
        };
      }
    }
    const before = process.memoryUsage().heapUsed;
    const results = await runLimitedPhase(jobs(), concurrency);
    const heapGrowth = process.memoryUsage().heapUsed - before;

    expect(results).toHaveLength(jobCount);
    expect(results[0]).toBe(0);
    expect(results.at(-1)).toBe(jobCount - 1);
    expect(maxActive).toBeLessThanOrEqual(concurrency);
    expect(maxOutstanding).toBeLessThanOrEqual(concurrency);
    expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
  });

  it("propagates AbortSignal to active work and stops pulling", async () => {
    const controller = new AbortController();
    let pulled = 0;
    function* jobs() {
      for (let index = 0; index < 100; index += 1) {
        pulled += 1;
        yield (signal: AbortSignal) =>
          new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => resolve(index), 1_000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true }
            );
          });
      }
    }
    const reason = new Error("stop now");
    const running = runLimitedPhase(jobs(), 4, { signal: controller.signal });
    await sleep(10);
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it("rejects absurd concurrency before pulling jobs or allocating workers", async () => {
    let pulled = 0;
    function* jobs() {
      pulled += 1;
      yield async () => 1;
    }
    await expect(runLimitedPhase(jobs(), maxPhaseConcurrency + 1)).rejects.toThrow(
      `no greater than ${maxPhaseConcurrency}`
    );
    expect(pulled).toBe(0);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
