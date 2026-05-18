import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function claimRunLock(runDir: string, jobId?: string): Promise<boolean> {
  await mkdir(runDir, { recursive: true });
  try {
    await writeFile(
      join(runDir, runArtifactFiles.lock),
      `${JSON.stringify({ job_id: jobId, worker_pid: process.pid, claimed_at: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new ConfigError(`Could not claim run directory lock: ${(error as Error).message}`, {
      code: "run.lock_failed",
      retryable: false,
      fix: "Choose a writable run directory."
    });
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
}
