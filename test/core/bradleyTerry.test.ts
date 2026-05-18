import { describe, expect, it } from "vitest";
import { fitBradleyTerry, type Comparison } from "@deepthonk/core";

function comparison(a: string, b: string, winner: "A" | "B" | "tie"): Comparison {
  return {
    id: `${a}-${b}`,
    runId: "test",
    generation: "final",
    candidateAId: a,
    candidateBId: b,
    presentedAOriginalId: a,
    presentedBOriginalId: b,
    winner,
    critiqueForA: "",
    critiqueForB: "",
    selectionReason: ""
  };
}

describe("fitBradleyTerry", () => {
  it("recovers A > B > C", () => {
    const scores = fitBradleyTerry(["A", "B", "C"], [
      comparison("A", "B", "A"),
      comparison("B", "C", "A"),
      comparison("A", "C", "A")
    ]);
    expect(scores.map((score) => score.candidateId)).toEqual(["A", "B", "C"]);
  });

  it("handles ties with near equal scores", () => {
    const scores = fitBradleyTerry(["A", "B"], [comparison("A", "B", "tie")]);
    expect(Math.abs(scores[0].score - scores[1].score)).toBeLessThan(1e-6);
    expect(scores[0].tieGroup).toBe(scores[1].tieGroup);
  });

  it("returns finite scores on disconnected graphs", () => {
    const scores = fitBradleyTerry(["A", "B", "C"], [comparison("A", "B", "A")]);
    expect(scores.every((score) => Number.isFinite(score.score))).toBe(true);
  });

  it("breaks exact ties by id", () => {
    const scores = fitBradleyTerry(["B", "A"], []);
    expect(scores.map((score) => score.candidateId)).toEqual(["A", "B"]);
    expect(scores.map((score) => score.tieGroup)).toEqual([1, 1]);
    expect(scores.map((score) => score.tieBreakerRank)).toEqual([1, 2]);
  });
});
