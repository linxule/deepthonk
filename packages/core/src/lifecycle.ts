import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { runArtifactFiles } from "./artifacts.js";
import { ConfigError } from "./errors.js";

export type RunLifecycleState = "pending" | "running" | "completed" | "failed" | "cancelled" | "budget_exceeded";

export interface BudgetUsage {
  calls: number;
  inputTokens: number;
  inputCacheHitTokens?: number;
  inputCacheMissTokens?: number;
  outputTokens: number;
  totalTokens: number;
  usd?: number;
}

export interface RunStatus {
  job_id?: string;
  run_id?: string;
  run_dir: string;
  state: RunLifecycleState;
  phase: string;
  generation?: number | "final";
  usage: BudgetUsage;
  started_at?: string;
  updated_at: string;
  completed_at?: string;
  worker_pid?: number;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    fix?: string;
  };
}

export interface RunLockData {
  schema_version: 1;
  claim_id: string;
  job_id?: string;
  hostname: string;
  worker_pid: number;
  claimed_at: string;
}

export interface RunLockClaim {
  claimId: string;
  fingerprint: string;
  lock: RunLockData;
}

export type RunLockInspection =
  | { state: "missing" }
  | { state: "valid"; fingerprint: string; lock: RunLockData; sameHost: boolean; workerAlive: boolean }
  | { state: "malformed"; fingerprint: string };

const localClaims = new Map<string, string>();
const runLockGuardFile = ".run.lock.guard";
const lockWaitTimeoutMs = 1_000;

export async function claimRunLock(runDir: string, jobId?: string): Promise<boolean> {
  return Boolean(await claimRunLockOwnership(runDir, jobId));
}

export async function claimRunLockOwnership(runDir: string, jobId?: string): Promise<RunLockClaim | undefined> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, runArtifactFiles.lock);
  const guard = await acquireRunLockGuard(runDir);
  try {
    const inspection = await inspectRunLock(runDir);
    if (inspection.state !== "missing") {
      if (inspection.state !== "valid" || !inspection.sameHost || inspection.workerAlive) return undefined;
      const current = await readFile(path, "utf8").catch(() => undefined);
      if (current === undefined || lockFingerprint(current) !== inspection.fingerprint) return undefined;
      await unlink(path);
      localClaims.delete(path);
    }
    const lock: RunLockData = {
      schema_version: 1,
      claim_id: randomUUID(),
      job_id: jobId,
      hostname: hostname(),
      worker_pid: process.pid,
      claimed_at: new Date().toISOString()
    };
    const raw = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(path, raw, { encoding: "utf8", flag: "wx" });
    const claim = { claimId: lock.claim_id, fingerprint: lockFingerprint(raw), lock };
    localClaims.set(path, claim.claimId);
    return claim;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Could not claim run directory lock: ${(error as Error).message}`, {
      code: "run.lock_failed",
      retryable: false,
      fix: "Choose a writable run directory."
    });
  } finally {
    await releaseRunLockGuard(guard);
  }
}

export async function inspectRunLock(runDir: string): Promise<RunLockInspection> {
  const path = join(runDir, runArtifactFiles.lock);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw new ConfigError(`Could not inspect run directory lock: ${(error as Error).message}`, {
      code: "run.lock_inspect_failed",
      retryable: false,
      fix: "Inspect the run directory lock file and permissions."
    });
  }
  const fingerprint = lockFingerprint(raw);
  try {
    const value = JSON.parse(raw) as Partial<RunLockData>;
    if (
      value.schema_version !== 1 ||
      typeof value.claim_id !== "string" ||
      typeof value.hostname !== "string" ||
      typeof value.worker_pid !== "number" ||
      !Number.isInteger(value.worker_pid) ||
      typeof value.claimed_at !== "string"
    ) {
      return { state: "malformed", fingerprint };
    }
    const lock = value as RunLockData;
    const sameHost = lock.hostname === hostname();
    return { state: "valid", fingerprint, lock, sameHost, workerAlive: sameHost ? isLivePid(lock.worker_pid) : true };
  } catch {
    return { state: "malformed", fingerprint };
  }
}

export async function reclaimRunLock(runDir: string, expectedFingerprint: string): Promise<boolean> {
  const path = join(runDir, runArtifactFiles.lock);
  const guard = await acquireRunLockGuard(runDir);
  try {
    const raw = await readFile(path, "utf8");
    if (lockFingerprint(raw) !== expectedFingerprint) return false;
    await unlink(path);
    localClaims.delete(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    await releaseRunLockGuard(guard);
  }
}

export async function verifyRunLockClaim(runDir: string, claim: RunLockClaim, jobId?: string): Promise<boolean> {
  const path = join(runDir, runArtifactFiles.lock);
  if (localClaims.get(path) !== claim.claimId) return false;
  const guard = await acquireRunLockGuard(runDir);
  try {
    const inspection = await inspectRunLock(runDir);
    return (
      inspection.state === "valid" &&
      inspection.fingerprint === claim.fingerprint &&
      inspection.lock.claim_id === claim.claimId &&
      inspection.lock.job_id === jobId
    );
  } finally {
    await releaseRunLockGuard(guard);
  }
}

export async function releaseRunLock(runDir: string, claimId?: string): Promise<void> {
  const path = join(runDir, runArtifactFiles.lock);
  const expectedClaimId = claimId ?? localClaims.get(path);
  const guard = await acquireRunLockGuard(runDir);
  try {
    const inspection = await inspectRunLock(runDir);
    if (inspection.state === "missing") {
      localClaims.delete(path);
      return;
    }
    if (inspection.state !== "valid" || !expectedClaimId || inspection.lock.claim_id !== expectedClaimId) {
      throw new ConfigError("Refusing to release a run lock not owned by this claimant.", {
        code: "run.lock_not_owned",
        retryable: false,
        fix: "Inspect the current lock and use fingerprinted reclaim only after verifying that its owner is no longer active."
      });
    }
    await unlink(path);
    localClaims.delete(path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Could not release run directory lock: ${(error as Error).message}`, {
      code: "run.lock_release_failed",
      retryable: false,
      fix: "Inspect the run directory lock file and permissions."
    });
  } finally {
    await releaseRunLockGuard(guard);
  }
}

interface LockGuardClaim {
  path: string;
  claimId: string;
  fingerprint: string;
}

async function acquireRunLockGuard(runDir: string): Promise<LockGuardClaim> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, runLockGuardFile);
  const deadline = Date.now() + lockWaitTimeoutMs;
  let blockingFingerprint: string | undefined;
  while (true) {
    const owner: RunLockData = {
      schema_version: 1,
      claim_id: randomUUID(),
      job_id: "run-lock-guard",
      hostname: hostname(),
      worker_pid: process.pid,
      claimed_at: new Date().toISOString()
    };
    const raw = `${JSON.stringify(owner)}\n`;
    try {
      await writeFile(path, raw, { encoding: "utf8", flag: "wx" });
      return { path, claimId: owner.claim_id, fingerprint: lockFingerprint(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await readFile(path, "utf8").catch(() => undefined);
      if (observed) blockingFingerprint = lockFingerprint(observed);
      if (Date.now() >= deadline) {
        throw new ConfigError(
          `Timed out waiting for the run-lock guard${blockingFingerprint ? ` (${blockingFingerprint})` : ""}.`,
          {
          code: "run.lock_guard_timeout",
          retryable: true,
          fix: "Retry after the active lock operation finishes. If its process crashed, inspect .run.lock.guard and remove that exact verified file manually; guards are never auto-reclaimed."
          }
        );
      }
      await delay(5);
    }
  }
}

async function releaseRunLockGuard(claim: LockGuardClaim): Promise<void> {
  const raw = await readFile(claim.path, "utf8").catch(() => undefined);
  if (!raw || lockFingerprint(raw) !== claim.fingerprint || parseLockOwner(raw)?.claim_id !== claim.claimId) {
    throw new ConfigError("Run-lock guard ownership changed before release.", {
      code: "run.lock_guard_not_owned",
      retryable: true
    });
  }
  await unlink(claim.path);
}

function parseLockOwner(raw: string): RunLockData | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RunLockData>;
    if (
      value.schema_version === 1 &&
      typeof value.claim_id === "string" &&
      typeof value.hostname === "string" &&
      typeof value.worker_pid === "number" &&
      Number.isInteger(value.worker_pid) &&
      typeof value.claimed_at === "string"
    ) {
      return value as RunLockData;
    }
  } catch {
    // Invalid guards are never auto-reclaimed.
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockFingerprint(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function readRunStatus(runDir: string): Promise<RunStatus | undefined> {
  try {
    return JSON.parse(await readFile(join(runDir, runArtifactFiles.status), "utf8")) as RunStatus;
  } catch {
    return undefined;
  }
}

export async function requestRunCancel(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, runArtifactFiles.cancel), `${JSON.stringify({ requested_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export async function isRunCancelRequested(runDir: string): Promise<boolean> {
  try {
    await readFile(join(runDir, runArtifactFiles.cancel), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function emptyUsage(): BudgetUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export interface UsageDelta {
  calls: number;
  inputTokens: number;
  inputCacheHitTokens?: number;
  inputCacheMissTokens?: number;
  outputTokens: number;
  totalTokens: number;
  inputUsd?: number;
  outputUsd?: number;
  usd?: number;
}

export type CallRole = "generator" | "judge" | "mutator" | "finalizer";

export interface UsageRecord {
  schema_version: 1;
  usage_id?: string;
  ts: string;
  phase: string;
  role: CallRole;
  provider?: string;
  model?: string;
  input_tokens: number;
  input_cache_hit_tokens?: number;
  input_cache_miss_tokens?: number;
  output_tokens: number;
  total_tokens: number;
  input_usd?: number;
  output_usd?: number;
  total_usd?: number;
  latency_ms?: number;
  retry_count?: number;
  outcome?: "success" | "failed";
  error_code?: string;
}
