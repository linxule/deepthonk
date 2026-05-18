import type { Candidate, Comparison } from "./schemas.js";

export function aggregateCritiques(candidates: Candidate[], comparisons: Comparison[]): Map<string, string> {
  const chunks = new Map(
    candidates.map((candidate) => [
      candidate.id,
      {
        wins: [] as string[],
        ties: [] as string[],
        losses: [] as string[]
      }
    ])
  );
  for (const comparison of comparisons) {
    const aBucket = bucketFor("A", comparison.winner);
    const bBucket = bucketFor("B", comparison.winner);
    chunks.get(comparison.presentedAOriginalId)?.[aBucket].push(selfRelative(comparison.critiqueForA, "A"));
    chunks.get(comparison.presentedBOriginalId)?.[bBucket].push(selfRelative(comparison.critiqueForB, "B"));
  }
  return new Map(
    [...chunks.entries()].map(([id, critiques]) => [
      id,
      [...critiques.wins, ...critiques.ties, ...critiques.losses].filter(Boolean).length > 0
        ? [
            formatSection("Feedback from comparisons this solution won", critiques.wins),
            formatSection("Feedback from comparisons this solution tied", critiques.ties),
            formatSection("Feedback from comparisons this solution lost", critiques.losses)
          ]
            .filter(Boolean)
            .join("\n\n")
        : "No specific critique was produced. Improve correctness, completeness, and clarity."
    ])
  );
}

function bucketFor(side: "A" | "B", winner: "A" | "B" | "tie"): "wins" | "ties" | "losses" {
  if (winner === "tie") return "ties";
  return winner === side ? "wins" : "losses";
}

function formatSection(title: string, critiques: string[]): string {
  const filtered = critiques.filter(Boolean);
  if (filtered.length === 0) return "";
  return `${title}:\n${filtered.map((critique, i) => `${i + 1}. ${critique}`).join("\n")}`;
}

function selfRelative(text: string, side: "A" | "B"): string {
  const other = side === "A" ? "B" : "A";
  return text
    .replaceAll(`Solution ${side}`, "your solution")
    .replaceAll(`solution ${side}`, "your solution")
    .replaceAll(`Candidate ${side}`, "your solution")
    .replaceAll(`candidate ${side}`, "your solution")
    .replaceAll(`Solution ${other}`, "the other solution")
    .replaceAll(`solution ${other}`, "the other solution")
    .replaceAll(`Candidate ${other}`, "the other solution")
    .replaceAll(`candidate ${other}`, "the other solution");
}
