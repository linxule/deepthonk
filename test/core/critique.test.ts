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

  it("deduplicates repeated feedback and truncates deterministically", () => {
    const repeated = "Solution A should add a boundary proof. ".repeat(20);
    const comparisons: Comparison[] = Array.from({ length: 3 }, (_, index) => ({
      id: `repeat-${index}`,
      runId: "r",
      generation: 1,
      candidateAId: "A",
      candidateBId: "B",
      presentedAOriginalId: "A",
      presentedBOriginalId: "B",
      winner: "B",
      critiqueForA: repeated,
      critiqueForB: "",
      selectionReason: ""
    }));
    const first = aggregateCritiques(candidates, comparisons, { aggregateChars: 200 }).get("A")!;
    const second = aggregateCritiques(candidates, comparisons, { aggregateChars: 200 }).get("A")!;
    expect(first).toBe(second);
    expect(first).toHaveLength(200);
    expect(first).toContain("[Critique truncated.]");
    expect(first.match(/boundary proof/g)?.length).toBe(3);
  });
});
