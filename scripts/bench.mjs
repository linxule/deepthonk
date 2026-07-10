import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fitBradleyTerry } from "../packages/core/dist/index.js";

const ci = process.argv.includes("--ci");
const cli = resolve("packages/cli/dist/index.js");
const samples = ci ? 5 : 9;

const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  runtime: process.version,
  samples,
  cli_version_ms: benchmarkCli(["--version"]),
  cli_plan_ms: benchmarkCli(["plan", "--profile", "paper"]),
  bradley_terry_sparse_ms: benchmarkBradleyTerry()
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (ci) {
  const failures = [];
  if (result.cli_version_ms.p95 > 250) failures.push(`CLI --version p95 ${result.cli_version_ms.p95}ms exceeds 250ms`);
  if (result.cli_plan_ms.p95 > 350) failures.push(`CLI plan p95 ${result.cli_plan_ms.p95}ms exceeds 350ms`);
  if (result.bradley_terry_sparse_ms.p95 > 500) failures.push(`Bradley-Terry p95 ${result.bradley_terry_sparse_ms.p95}ms exceeds 500ms`);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}

function benchmarkCli(args) {
  const durations = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const child = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const elapsed = performance.now() - started;
    if (child.status !== 0) throw new Error(`CLI benchmark failed: ${child.stderr || child.stdout}`);
    durations.push(elapsed);
  }
  return summarize(durations);
}

function benchmarkBradleyTerry() {
  const candidateCount = 2_000;
  const degree = 10;
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    id: `c-${index}`,
    generation: 0,
    kind: "benchmark",
    content: `candidate ${index}`,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z" }
  }));
  const comparisons = [];
  for (let offset = 1; offset <= degree / 2; offset += 1) {
    for (let index = 0; index < candidateCount; index += 1) {
      const opponent = (index + offset) % candidateCount;
      comparisons.push({
        id: `p-${offset}-${index}`,
        runId: "benchmark",
        generation: "final",
        candidateAId: candidates[index].id,
        candidateBId: candidates[opponent].id,
        winner: index % 3 === 0 ? "tie" : index % 2 === 0 ? "A" : "B"
      });
    }
  }
  const durations = [];
  for (let i = 0; i < samples; i += 1) {
    globalThis.gc?.();
    const started = performance.now();
    fitBradleyTerry(candidates, comparisons, 0.01, "final");
    durations.push(performance.now() - started);
  }
  return { candidates: candidateCount, comparisons: comparisons.length, ...summarize(durations) };
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1))
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
