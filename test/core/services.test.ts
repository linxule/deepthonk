import { describe, expect, it } from "vitest";
import { mutateCandidate, rankCandidates } from "@deepthonk/core";
import { FakeDriver } from "@deepthonk/providers";

describe("core services", () => {
  it("ranks user-supplied candidates through a shared ModelDriver service", async () => {
    const result = await rankCandidates({
      task: "pick the best",
      candidates: ["FAKE_QUALITY:1", "FAKE_QUALITY:9"],
      driver: new FakeDriver(),
      judgeModel: "fake-model"
    });

    expect(result.comparisons).toHaveLength(1);
    expect(result.scores[0]?.candidateId).toBe("candidate-2");
  });

  it("refuses to synthesize a tie when the judge returns persistent invalid JSON", async () => {
    const garbageDriver = {
      async generate() { return { text: "x" }; },
      async compare() { return { text: "this is not JSON at all" }; },
      async mutate() { return { text: "x" }; }
    };
    await expect(
      rankCandidates({
        task: "pick the best",
        candidates: ["FAKE_QUALITY:1", "FAKE_QUALITY:9"],
        driver: garbageDriver,
        judgeModel: "garbage-judge"
      })
    ).rejects.toMatchObject({ code: "judge.persistent_invalid_json", retryable: false });
  });

  it("mutates one user-supplied candidate through a shared ModelDriver service", async () => {
    const result = await mutateCandidate({
      task: "improve",
      candidate: "FAKE_QUALITY:1",
      critique: "raise quality",
      driver: new FakeDriver(),
      mutatorModel: "fake-model"
    });

    expect(result.mutated).toContain("FAKE_QUALITY:8");
  });
});
