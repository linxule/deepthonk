import type { Command } from "commander";
import { readRunArtifact, runArtifactFiles, type BtScore, type Candidate, type Comparison } from "@deepthonk/core";
import { TraceStore } from "@deepthonk/core";
import { resolveCliPath } from "../config.js";

export function registerInspect(program: Command): void {
  program
    .command("inspect")
    .description("Inspect a DeepThonk run directory.")
    .argument("<runDir>")
    .option("--generation <generation>")
    .action(async (runDir: string, options) => {
      runDir = resolveCliPath(runDir);
      const trace = new TraceStore(runDir);
      const summary = await trace.readSummary();
      const scores = await trace.readJsonl<BtScore>(runArtifactFiles.scores);
      const candidates = await trace.readJsonl<Candidate>(runArtifactFiles.candidates);
      const comparisons = await trace.readJsonl<Comparison>(runArtifactFiles.comparisons);
      const generation = options.generation ?? "final";
      const topScores = scores
        .filter((score) => String(score.generation) === String(generation))
        .sort((left, right) => left.rank - right.rank)
        .slice(0, 5);
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const finalText = await readRunArtifact(runDir, "final").catch(() => "");
      console.log(
        JSON.stringify(
          {
            summary,
            call_counts: {
              candidates: candidates.length,
              comparisons: comparisons.length
            },
            top_candidates: topScores.map((score) => ({
              ...score,
              preview: byId.get(score.candidateId)?.content.slice(0, 160)
            })),
            final_preview: finalText.slice(0, 500)
          },
          null,
          2
        )
      );
    });
}
