import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const runArtifactFiles = {
  config: "config.json",
  summary: "summary.json",
  candidates: "candidates.jsonl",
  comparisons: "comparisons.jsonl",
  scores: "scores.jsonl",
  usage: "usage.jsonl",
  trace: "events.jsonl",
  final: "artifacts/final.txt",
  winner: "artifacts/winner.txt",
  status: "status.json",
  cancel: "cancel.json",
  lock: "run.lock"
} as const;

export type RunArtifactName = keyof typeof runArtifactFiles;
export type RunExportFormat = "json" | "markdown" | "jsonl";

export const traceJsonlFiles = [
  runArtifactFiles.trace,
  runArtifactFiles.candidates,
  runArtifactFiles.comparisons,
  runArtifactFiles.scores
] as const;

export interface ResumeStatus {
  status: "completed" | "interrupted" | "missing" | "running" | "cancel_requested" | "cancelled" | "failed" | "budget_exceeded" | "resumable";
  message: string;
  run_id?: string;
  phase?: string;
  generation?: number | "final";
  safe_to_continue?: boolean;
}

export interface RunRecord {
  run_id: string;
  run_dir: string;
}

export async function readRunArtifact(runDir: string, artifact: RunArtifactName): Promise<string> {
  return readFile(join(runDir, runArtifactFiles[artifact]), "utf8");
}

export async function readRunSummary(runDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readRunArtifact(runDir, "summary")) as Record<string, unknown>;
}

export async function exportRun(runDir: string, format: RunExportFormat): Promise<Record<string, unknown>> {
  if (format === "json") return readRunSummary(runDir);
  if (format === "jsonl") {
    const text = await Promise.all(traceJsonlFiles.map((file) => readFile(join(runDir, file), "utf8").catch(() => "")));
    return { jsonl: text.join("") };
  }
  if (format !== "markdown") throw new Error(`Unsupported export format: ${format}. Use json, markdown, or jsonl.`);
  const summary = await readRunSummary(runDir);
  const final = await readRunArtifact(runDir, "final").catch(() => "");
  return { markdown: `# DeepThonk Run ${summary.run_id}\n\nWinner: ${summary.winner_id}\n\nCalls: ${summary.calls}\n\n## Final Answer\n\n${final}` };
}

export async function detectResumeState(runDir: string): Promise<ResumeStatus> {
  try {
    const summary = await readRunSummary(runDir);
    return {
      status: "completed",
      message: "Run already has summary.json; nothing to resume.",
      run_id: typeof summary.run_id === "string" ? summary.run_id : undefined,
      safe_to_continue: false
    };
  } catch {
    const status = await readStatusArtifact(runDir);
    if (status) {
      if ((status.state === "running" || status.state === "pending") && isLiveWorker(status.worker_pid)) {
        return {
          status: "running",
          message: `Run is ${status.state} at phase ${status.phase}. Use status/result or cancel before starting a replay.`,
          run_id: status.run_id,
          phase: status.phase,
          generation: status.generation,
          safe_to_continue: false
        };
      }
      if (status.state === "running" || status.state === "pending") {
        return {
          status: "interrupted",
          message: `Run status is stale at phase ${status.phase}; the recorded worker is no longer live.`,
          run_id: status.run_id,
          phase: status.phase,
          generation: status.generation,
          safe_to_continue: false
        };
      }
      if (status.state === "cancelled" || status.state === "failed" || status.state === "budget_exceeded") {
        return {
          status: status.state,
          message: resumeMessage(status),
          run_id: status.run_id,
          phase: status.phase,
          generation: status.generation,
          safe_to_continue: false
        };
      }
    }
    try {
      await readRunArtifact(runDir, "cancel");
      return { status: "cancel_requested", message: "Cancellation has been requested, but no active run status exists.", safe_to_continue: false };
    } catch {
      // Continue with trace detection.
    }
    try {
      await readRunArtifact(runDir, "trace");
      return {
        status: "interrupted",
        message: "Interrupted trace detected. Conservative resume is trace-boundary only; this trace has no complete resumable boundary marker.",
        safe_to_continue: false
      };
    } catch {
      return { status: "missing", message: "No DeepThonk trace found in run directory.", safe_to_continue: false };
    }
  }
}

async function readStatusArtifact(runDir: string): Promise<
  | {
      state?: ResumeStatus["status"] | "pending";
      worker_pid?: number;
      run_id?: string;
      phase?: string;
      generation?: number | "final";
      error?: { message?: string; fix?: string };
    }
  | undefined
> {
  try {
    return JSON.parse(await readRunArtifact(runDir, "status")) as {
      state?: ResumeStatus["status"] | "pending";
      worker_pid?: number;
      run_id?: string;
      phase?: string;
      generation?: number | "final";
      error?: { message?: string; fix?: string };
    };
  } catch {
    return undefined;
  }
}

function isLiveWorker(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resumeMessage(status: { state?: string; phase?: string; error?: { message?: string; fix?: string } }): string {
  const phase = status.phase ? ` at phase ${status.phase}` : "";
  const error = status.error?.message ? ` Last error: ${status.error.message}` : "";
  const fix = status.error?.fix ? ` Fix: ${status.error.fix}` : "";
  return `Run is ${status.state ?? "interrupted"}${phase}.${error}${fix}`;
}

export async function resolveRunDir(runId: string, runsRoot = "runs"): Promise<string> {
  const direct = join(runsRoot, runId);
  try {
    await readRunArtifact(direct, "summary");
    return direct;
  } catch {
    // Fall through and scan the run index plus run summaries.
  }

  const indexed = await readRunIndex(runId, runsRoot);
  if (indexed) return indexed;

  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(runsRoot, entry.name);
    try {
      const summary = (await readRunSummary(candidate)) as { run_id?: string };
      if (summary.run_id === runId) return candidate;
    } catch {
      // Ignore incomplete or non-DeepThonk directories.
    }
  }
  return direct;
}

export async function listRunRecords(runsRoot = "runs"): Promise<RunRecord[]> {
  const records = new Map<string, RunRecord>();
  for (const entry of await readRunIndexEntries(runsRoot)) {
    if (!entry.run_id || !entry.run_dir) continue;
    try {
      await readRunSummary(entry.run_dir);
      records.set(entry.run_id, { run_id: entry.run_id, run_dir: entry.run_dir });
    } catch {
      // Ignore stale index entries.
    }
  }

  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsRoot, entry.name);
    try {
      const summary = (await readRunSummary(runDir)) as { run_id?: string };
      const runId = summary.run_id ?? entry.name;
      records.set(runId, { run_id: runId, run_dir: runDir });
    } catch {
      // Ignore incomplete or non-DeepThonk directories.
    }
  }

  return [...records.values()].sort((left, right) => left.run_id.localeCompare(right.run_id));
}

export async function recordRunIndex(runId: string, runDir: string, runsRoot = "runs"): Promise<void> {
  await mkdir(runsRoot, { recursive: true });
  await writeFile(join(runsRoot, "index.jsonl"), `${JSON.stringify({ run_id: runId, run_dir: runDir })}\n`, {
    encoding: "utf8",
    flag: "a"
  });
}

async function readRunIndex(runId: string, runsRoot: string): Promise<string | undefined> {
  const entries = await readRunIndexEntries(runsRoot);
  return entries.reverse().find((entry) => entry.run_id === runId)?.run_dir;
}

async function readRunIndexEntries(runsRoot: string): Promise<Array<{ run_id?: string; run_dir?: string }>> {
  try {
    const text = await readFile(join(runsRoot, "index.jsonl"), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { run_id?: string; run_dir?: string });
  } catch {
    return [];
  }
}
