import { describe, expect, it } from "vitest";
import { aggregateCritiques, type Candidate, type Comparison } from "@deepthonk/core";

const candidates: Candidate[] = [
  { id: "A", generation: 0, kind: "initial", content: "a", metadata: { createdAt: "now" } },
  { id: "B", generation: 0, kind: "initial", content: "b", metadata: { createdAt: "now" } }
];

describe("aggregateCritiques", () => {
  it("groups feedback by win/tie/loss and rewrites solution labels self-relatively", () => {
    const comparisons: Comparison[] = [
      {
        id: "c1",
        runId: "r",
        generation: 1,
        candidateAId: "A",
        candidateBId: "B",
        presentedAOriginalId: "A",
        presentedBOriginalId: "B",
        winner: "A",
        critiqueForA: "Solution A is complete; Solution B missed edge cases.",
        critiqueForB: "Solution B missed edge cases compared with Solution A.",
        selectionReason: ""
      },
      {
        id: "c2",
        runId: "r",
        generation: 1,
        candidateAId: "A",
        candidateBId: "B",
        presentedAOriginalId: "B",
        presentedBOriginalId: "A",
        winner: "tie",
        critiqueForA: "Candidate A is concise.",
        critiqueForB: "Candidate B is also concise.",
        selectionReason: ""
      }
    ];

    const a = aggregateCritiques(candidates, comparisons).get("A");
    const b = aggregateCritiques(candidates, comparisons).get("B");
    expect(a).toContain("Feedback from comparisons this solution won");
    expect(a).toContain("Feedback from comparisons this solution tied");
    expect(a).toContain("your solution is complete");
    expect(a).toContain("the other solution missed edge cases");
    expect(b).toContain("Feedback from comparisons this solution lost");
    expect(b).toContain("your solution missed edge cases");
  });
});
