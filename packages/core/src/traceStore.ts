import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { runArtifactFiles, traceJsonlFiles } from "./artifacts.js";
import { TraceError } from "./errors.js";
import type { RunStatus, UsageRecord } from "./lifecycle.js";
import type { BtScore, Candidate, Comparison, RunConfig } from "./schemas.js";
import { traceSchemaVersion } from "./checkpointStore.js";

export class TraceStore {
  readonly runDir: string;
  // Single-writer queue: every appendJsonl chains onto this promise so concurrent
  // writes (e.g. from pLimit closures writing candidates/comparisons as each
  // call completes) cannot interleave on disk.
  private readonly appendHandles = new Map<string, Promise<FileHandle>>();
  private readonly pendingBatches = new Map<
    string,
    { rows: string[]; waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>; scheduled: boolean }
  >();
  private readonly flushes = new Map<string, Promise<void>>();
  private readonly dirtyHandles = new Set<string>();
  private appendWrites = 0;
  private appendRows = 0;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  async init(config: RunConfig, runId: string, preflight: { allowOwnedLock?: boolean; pendingJobId?: string } = {}): Promise<void> {
    await mkdir(join(this.runDir, "artifacts"), { recursive: true });
    await this.assertFreshTrace(preflight);
    await this.writeJson(runArtifactFiles.config, redactConfig({ ...config, runId, traceSchemaVersion }));
    await this.event({ type: "run.started", run_id: runId, created_at: new Date().toISOString() });
  }

  async event(event: Record<string, unknown>): Promise<void> {
    await this.appendJsonl(runArtifactFiles.trace, event);
  }

  async writeCandidate(candidate: Candidate): Promise<void> {
    await this.appendJsonl(runArtifactFiles.candidates, candidate);
  }

  async writeComparison(comparison: Comparison): Promise<void> {
    await this.appendJsonl(runArtifactFiles.comparisons, comparison);
  }

  async writeScores(generation: number | "final", scores: BtScore[]): Promise<void> {
    await this.appendJsonlMany(runArtifactFiles.scores, scores);
    await this.event({ type: "scores.computed", generation });
  }

  async writePopulation(generation: number, population: Candidate[]): Promise<void> {
    await this.writeJson(`population-${generation}.json`, population);
  }

  async writeSummary(summary: Record<string, unknown>, finalAnswer: string, winnerAnswer?: string): Promise<void> {
    await this.flush();
    if (winnerAnswer !== undefined) await writeFile(join(this.runDir, runArtifactFiles.winner), winnerAnswer, "utf8");
    await writeFile(join(this.runDir, runArtifactFiles.final), finalAnswer, "utf8");
    await this.writeJson(runArtifactFiles.summary, summary);
  }

  async writeStatus(status: RunStatus): Promise<void> {
    let flushError: unknown;
    try {
      await this.flush();
    } catch (error) {
      flushError = error;
    }
    await this.writeJson(runArtifactFiles.status, status);
    if (flushError !== undefined) throw flushError;
  }

  async writeUsage(record: UsageRecord): Promise<void> {
    await this.appendJsonl(runArtifactFiles.usage, record);
  }

  async readSummary(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(this.runDir, runArtifactFiles.summary), "utf8")) as Record<string, unknown>;
  }

  async readJsonl<T>(fileName: string): Promise<T[]> {
    try {
      await this.flush();
      const text = await readFile(join(this.runDir, fileName), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      throw new TraceError(`Could not read ${fileName}: ${(error as Error).message}`);
    }
  }

  async listFiles(): Promise<string[]> {
    return readdir(this.runDir);
  }

  async writePrompt(prompt: { system: string; user: string }): Promise<{ sha256: string; path: string }> {
    const serialized = `${JSON.stringify(prompt, null, 2)}\n`;
    const sha256 = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
    const relativePath = `artifacts/prompts/${sha256.slice("sha256:".length)}.json`;
    const path = join(this.runDir, relativePath);
    await mkdir(join(this.runDir, "artifacts", "prompts"), { recursive: true });
    try {
      await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path, "utf8");
      if (`sha256:${createHash("sha256").update(existing).digest("hex")}` !== sha256) {
        throw new TraceError(`Prompt blob hash mismatch at ${relativePath}.`);
      }
    }
    return { sha256, path: relativePath };
  }

  async readPrompt(reference: { sha256: string; path: string }): Promise<{ system: string; user: string }> {
    if (!/^sha256:[0-9a-f]{64}$/.test(reference.sha256)) throw new TraceError("Prompt reference has an invalid SHA-256 digest.");
    const expectedPath = `artifacts/prompts/${reference.sha256.slice("sha256:".length)}.json`;
    if (reference.path !== expectedPath) throw new TraceError("Prompt reference path does not match its content digest.");
    const raw = await readFile(join(this.runDir, expectedPath), "utf8");
    if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== reference.sha256) {
      throw new TraceError(`Prompt blob hash mismatch at ${reference.path}.`);
    }
    return JSON.parse(raw) as { system: string; user: string };
  }

  metrics(): { appendWrites: number; appendRows: number } {
    return { appendWrites: this.appendWrites, appendRows: this.appendRows };
  }

  async flush(): Promise<void> {
    for (const fileName of [...this.pendingBatches.keys()]) await this.flushFile(fileName);
    await Promise.all([...this.flushes.values()]);
    const dirty = [...this.dirtyHandles];
    await Promise.all(
      dirty.map(async (fileName) => {
        const handle = this.appendHandles.get(fileName);
        if (handle) await (await handle).sync();
        this.dirtyHandles.delete(fileName);
      })
    );
  }

  async close(): Promise<void> {
    let flushError: unknown;
    try {
      await this.flush();
    } catch (error) {
      flushError = error;
    }
    const handles = await Promise.allSettled([...this.appendHandles.values()]);
    this.appendHandles.clear();
    await Promise.all(handles.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])));
    if (flushError !== undefined) throw flushError;
  }

  private async appendJsonl(fileName: string, value: unknown): Promise<void> {
    await this.appendJsonlMany(fileName, [value]);
  }

  private async appendJsonlMany(fileName: string, values: readonly unknown[]): Promise<void> {
    if (values.length === 0) return;
    await mkdir(this.runDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const batch = this.pendingBatches.get(fileName) ?? { rows: [], waiters: [], scheduled: false };
      batch.rows.push(...values.map((value) => JSON.stringify(value)));
      batch.waiters.push({ resolve, reject });
      this.pendingBatches.set(fileName, batch);
      if (!batch.scheduled) {
        batch.scheduled = true;
        setImmediate(() => void this.flushFile(fileName));
      }
    });
  }

  private async flushFile(fileName: string): Promise<void> {
    const active = this.flushes.get(fileName);
    if (active) return active;
    const flushing = (async () => {
      while (true) {
        const batch = this.pendingBatches.get(fileName);
        if (!batch || batch.rows.length === 0) break;
        this.pendingBatches.delete(fileName);
        let handle: FileHandle | undefined;
        try {
          const handlePromise = this.appendHandles.get(fileName) ?? open(join(this.runDir, fileName), "a");
          this.appendHandles.set(fileName, handlePromise);
          handle = await handlePromise;
          await handle.appendFile(`${batch.rows.join("\n")}\n`, "utf8");
          this.dirtyHandles.add(fileName);
          this.appendWrites += 1;
          this.appendRows += batch.rows.length;
          for (const waiter of batch.waiters) waiter.resolve();
        } catch (error) {
          this.appendHandles.delete(fileName);
          this.dirtyHandles.delete(fileName);
          if (handle) await handle.close().catch(() => undefined);
          for (const waiter of batch.waiters) waiter.reject(error);
        }
      }
    })();
    this.flushes.set(fileName, flushing);
    try {
      await flushing;
    } finally {
      if (this.flushes.get(fileName) === flushing) this.flushes.delete(fileName);
      const pending = this.pendingBatches.get(fileName);
      if (pending && pending.rows.length > 0) {
        pending.scheduled = true;
        setImmediate(() => void this.flushFile(fileName));
      }
    }
  }

  private async writeJson(fileName: string, value: unknown): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    const target = join(this.runDir, fileName);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async assertFreshTrace(preflight: { allowOwnedLock?: boolean; pendingJobId?: string }): Promise<void> {
    const managedFiles = new Set<string>([
      ...Object.values(runArtifactFiles),
      ...traceJsonlFiles,
      ".prune-in-progress"
    ]);
    const entries = await readdir(this.runDir, { recursive: true }).catch(() => [] as string[]);
    for (const file of entries) {
      const normalized = file.replaceAll("\\", "/");
      const base = normalized.split("/").at(-1) ?? normalized;
      if (normalized === runArtifactFiles.lock && preflight.allowOwnedLock) continue;
      if (normalized === runArtifactFiles.status && preflight.pendingJobId !== undefined) {
        const status = await readPendingStatus(join(this.runDir, normalized));
        if (status?.state === "pending" && status.job_id === preflight.pendingJobId) continue;
      }
      const isManaged =
        managedFiles.has(normalized) ||
        managedFiles.has(base) ||
        /^population-\d+\.json$/.test(base) ||
        normalized.startsWith("manifests/") ||
        normalized.startsWith("checkpoints/") ||
        normalized.startsWith("commits/") ||
        normalized.startsWith("artifacts/prompts/");
      if (isManaged) {
        throw new TraceError(`Run directory already contains ${normalized}; choose a new --out directory or remove the old trace first.`);
      }
    }
  }
}

async function readPendingStatus(path: string): Promise<{ state?: unknown; job_id?: unknown } | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as { state?: unknown; job_id?: unknown };
  } catch {
    return undefined;
  }
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return redactValue(config) as Record<string, unknown>;
}

function redactValue(value: unknown, key = ""): unknown {
  if (isSecretValueKey(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
  }
  return value;
}

function isSecretValueKey(key: string): boolean {
  if (/^(apiKeyEnv|api_key_env|apiKeyFile|api_key_file|apiKeyStdin|api_key_stdin)$/i.test(key)) return false;
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (["secret", "password", "authorization", "bearer", "cookie", "credential", "credentials", "privatekey"].includes(normalized)) {
    return true;
  }
  return /(?:apikey|secretkey|accesstoken|refreshtoken|authtoken|idtoken|secrettoken|sessiontoken|clientsecret|privatekey)$/.test(normalized);
}
