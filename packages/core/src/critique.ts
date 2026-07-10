import type { Candidate, Comparison } from "./schemas.js";

export function aggregateCritiques(
  candidates: Candidate[],
  comparisons: Comparison[],
  options: { aggregateChars?: number } = {}
): Map<string, string> {
  const aggregateChars = options.aggregateChars ?? 16_000;
  const chunks = new Map(
    candidates.map((candidate) => [
      candidate.id,
      {
        wins: [] as string[],
        ties: [] as string[],
        losses: [] as string[],
        seen: new Set<string>()
      }
    ])
  );
  for (const comparison of comparisons) {
    const aBucket = bucketFor("A", comparison.winner);
    const bBucket = bucketFor("B", comparison.winner);
    addCritique(chunks.get(comparison.presentedAOriginalId), aBucket, selfRelative(comparison.critiqueForA, "A"));
    addCritique(chunks.get(comparison.presentedBOriginalId), bBucket, selfRelative(comparison.critiqueForB, "B"));
  }
  return new Map(
    [...chunks.entries()].map(([id, critiques]): [string, string] => {
      const value = [...critiques.wins, ...critiques.ties, ...critiques.losses].filter(Boolean).length > 0
        ? [
            formatSection("Feedback from comparisons this solution won", critiques.wins),
            formatSection("Feedback from comparisons this solution tied", critiques.ties),
            formatSection("Feedback from comparisons this solution lost", critiques.losses)
          ]
            .filter(Boolean)
            .join("\n\n")
        : "No specific critique was produced. Improve correctness, completeness, and clarity.";
      return [id, truncateCritique(value, aggregateChars)];
    })
  );
}

function addCritique(
  chunks: { wins: string[]; ties: string[]; losses: string[]; seen: Set<string> } | undefined,
  bucket: "wins" | "ties" | "losses",
  critique: string
): void {
  const normalized = critique.trim();
  if (!chunks || !normalized || chunks.seen.has(normalized)) return;
  chunks.seen.add(normalized);
  chunks[bucket].push(normalized);
}

function truncateCritique(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n\n[Critique truncated.]";
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`.slice(0, maxChars);
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
