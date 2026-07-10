import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

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

const indexWriteQueues = new Map<string, Promise<void>>();
const indexLockWaitTimeoutMs = 5_000;

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
  const status = await readStatusArtifact(runDir);
  if (await runLockExists(runDir)) {
    return {
      status: "running",
      message: "Run lock is still held; terminal artifacts are not safe to report until the owner releases it.",
      run_id: status?.run_id,
      phase: status?.phase,
      generation: status?.generation,
      safe_to_continue: false
    };
  }
  try {
    const summary = await readRunSummary(runDir);
    return {
      status: "completed",
      message: "Run already has summary.json; nothing to resume.",
      run_id: typeof summary.run_id === "string" ? summary.run_id : undefined,
      safe_to_continue: false
    };
  } catch {
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

async function runLockExists(runDir: string): Promise<boolean> {
  try {
    await readFile(join(runDir, runArtifactFiles.lock), "utf8");
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
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
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
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
  const canonicalRoot = await realpath(runsRoot);
  const path = join(canonicalRoot, "index.jsonl");
  const previous = indexWriteQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const lock = await acquireIndexLock(canonicalRoot);
    try {
      const existing = (await readRunIndexEntries(canonicalRoot)).filter((entry) => entry.run_id === runId);
      const conflict = existing.find((entry) => entry.run_dir && entry.run_dir !== runDir);
      if (conflict) {
        throw new ConfigError(`Run ID ${runId} is already indexed at ${conflict.run_dir}; refusing to remap it to ${runDir}.`, {
          code: "run.index_conflict",
          retryable: false,
          fix: "Choose a unique run ID or use the already indexed run directory."
        });
      }
      if (existing.some((entry) => entry.run_dir === runDir)) return;
      await writeFile(path, `${JSON.stringify({ run_id: runId, run_dir: runDir })}\n`, {
        encoding: "utf8",
        flag: "a"
      });
    } finally {
      await releaseIndexLock(lock);
    }
  });
  indexWriteQueues.set(path, next);
  try {
    await next;
  } finally {
    if (indexWriteQueues.get(path) === next) indexWriteQueues.delete(path);
  }
}

interface IndexLockOwner {
  schema_version: 1;
  claim_id: string;
  hostname: string;
  worker_pid: number;
  claimed_at: string;
}

interface IndexLockClaim {
  path: string;
  claimId: string;
  fingerprint: string;
}

async function acquireIndexLock(runsRoot: string): Promise<IndexLockClaim> {
  const path = join(runsRoot, "index.jsonl.lock");
  const deadline = Date.now() + indexLockWaitTimeoutMs;
  while (true) {
    const owner: IndexLockOwner = {
      schema_version: 1,
      claim_id: randomUUID(),
      hostname: hostname(),
      worker_pid: process.pid,
      claimed_at: new Date().toISOString()
    };
    const raw = `${JSON.stringify(owner)}\n`;
    try {
      await writeFile(path, raw, { encoding: "utf8", flag: "wx" });
      return { path, claimId: owner.claim_id, fingerprint: fingerprint(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await readFile(path, "utf8").catch(() => undefined);
      const stale = observed ? parseIndexLockOwner(observed) : undefined;
      if (observed && stale?.hostname === hostname() && !isLivePid(stale.worker_pid)) {
        await quarantineStaleIndexLock(path, observed);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ConfigError("Timed out waiting for the run index writer lock.", {
          code: "run.index_locked",
          retryable: true,
          fix: "Retry after the active index writer finishes; inspect index.jsonl.lock if its owner crashed."
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function releaseIndexLock(claim: IndexLockClaim): Promise<void> {
  const raw = await readFile(claim.path, "utf8").catch(() => undefined);
  const owner = raw ? parseIndexLockOwner(raw) : undefined;
  if (!raw || fingerprint(raw) !== claim.fingerprint || owner?.claim_id !== claim.claimId) {
    throw new ConfigError("Run index writer lock ownership changed before release.", {
      code: "run.index_lock_not_owned",
      retryable: true
    });
  }
  await unlink(claim.path);
}

async function quarantineStaleIndexLock(path: string, observed: string): Promise<void> {
  const quarantine = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await readFile(quarantine, "utf8").catch(() => undefined);
  if (moved && fingerprint(moved) === fingerprint(observed)) {
    await unlink(quarantine).catch(() => undefined);
    return;
  }
  if (moved) {
    try {
      await link(quarantine, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  await unlink(quarantine).catch(() => undefined);
}

function parseIndexLockOwner(raw: string): IndexLockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<IndexLockOwner>;
    if (
      value.schema_version === 1 &&
      typeof value.claim_id === "string" &&
      typeof value.hostname === "string" &&
      typeof value.worker_pid === "number" &&
      Number.isInteger(value.worker_pid) &&
      typeof value.claimed_at === "string"
    ) {
      return value as IndexLockOwner;
    }
  } catch {
    // Malformed locks require explicit operator inspection.
  }
  return undefined;
}

function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readRunIndex(runId: string, runsRoot: string): Promise<string | undefined> {
  const entries = await readRunIndexEntries(runsRoot);
  return entries.reverse().find((entry) => entry.run_id === runId)?.run_dir;
}

async function readRunIndexEntries(runsRoot: string): Promise<Array<{ run_id?: string; run_dir?: string }>> {
  try {
    const text = await readFile(join(runsRoot, "index.jsonl"), "utf8");
    const entries: Array<{ run_id?: string; run_dir?: string }> = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { run_id?: unknown; run_dir?: unknown };
        if (typeof entry.run_id === "string" && typeof entry.run_dir === "string") {
          entries.push({ run_id: entry.run_id, run_dir: entry.run_dir });
        }
      } catch {
        // A malformed row must not hide valid records before or after it.
      }
    }
    return entries;
  } catch {
    return [];
  }
}
