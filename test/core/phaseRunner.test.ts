import { describe, expect, it } from "vitest";
import { runLimitedPhase } from "@deepthonk/core";

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
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
