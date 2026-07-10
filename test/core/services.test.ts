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

  it("rejects duplicate candidate IDs before scheduling self-comparisons", async () => {
    await expect(
      rankCandidates({
        task: "pick the best",
        candidates: [
          { id: "duplicate", content: "FAKE_QUALITY:1" },
          { id: "duplicate", content: "FAKE_QUALITY:9" }
        ],
        driver: new FakeDriver(),
        judgeModel: "fake-model"
      })
    ).rejects.toMatchObject({ code: "rank.duplicate_candidate_id" });
  });

  it("balances seeded A/B presentation and keeps it deterministic", async () => {
    const options = {
      task: "pick the best",
      candidates: ["FAKE_QUALITY:1", "FAKE_QUALITY:2", "FAKE_QUALITY:3", "FAKE_QUALITY:4"],
      driver: new FakeDriver(),
      judgeModel: "fake-model",
      seed: 77
    };
    const first = await rankCandidates(options);
    const second = await rankCandidates(options);
    const presentations = (result: typeof first) => result.comparisons.map((comparison) => [comparison.candidateAId, comparison.candidateBId]);
    expect(presentations(first)).toEqual(presentations(second));
    for (const candidate of first.candidates) {
      const asA = first.comparisons.filter((comparison) => comparison.candidateAId === candidate.id).length;
      const asB = first.comparisons.filter((comparison) => comparison.candidateBId === candidate.id).length;
      expect(Math.abs(asA - asB)).toBeLessThanOrEqual(1);
    }
  });

  it("does not label winner-only valid JSON as an invalid comparison", async () => {
    const winnerOnlyDriver = {
      async generate() { return { text: "x" }; },
      async compare() { return { text: JSON.stringify({ winner: "A" }) }; },
      async mutate() { return { text: "x" }; }
    };
    const result = await rankCandidates({
      task: "pick the best",
      candidates: ["first", "second"],
      driver: winnerOnlyDriver,
      judgeModel: "winner-only"
    });
    expect(result.comparisons[0]).toMatchObject({ critiqueForA: "", critiqueForB: "", selectionReason: "" });
  });
});
