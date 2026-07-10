import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError } from "./errors.js";
import { runLimitedPhase } from "./phaseRunner.js";

export const traceSchemaVersion = 2 as const;

export interface CheckpointJob<T> {
  id: string;
  input: unknown;
  run(signal: AbortSignal): Promise<T>;
  receiptUsage?: () => unknown;
}

export interface PhaseManifest {
  schema_version: 2;
  phase_key: string;
  manifest_hash: string;
  work: Array<{ work_id: string; input_hash: string }>;
  created_at: string;
}

export interface WorkCheckpoint<T = unknown> {
  schema_version: 2;
  phase_key: string;
  work_id: string;
  input_hash: string;
  output_hash: string;
  output: T;
  usage?: unknown;
  usage_hash: string;
  attempt_id: string;
  completed_at: string;
}

export interface PhaseCommit {
  schema_version: 2;
  phase_key: string;
  manifest_hash: string;
  checkpoint_hashes: Record<string, string>;
  artifact_hashes: Record<string, string>;
  committed_at: string;
}

export async function runCheckpointedPhase<T>(options: {
  runDir: string;
  phaseKey: string;
  jobs: readonly CheckpointJob<T>[];
  concurrency: number;
  signal?: AbortSignal;
  validateOutput?: (output: unknown) => output is T;
  onResult?: (output: T, context: { workId: string; reused: boolean; receiptUsage: unknown }) => Promise<void>;
}): Promise<T[]> {
  assertUniqueWorkIds(options.jobs);
  const manifest = await ensurePhaseManifest(options.runDir, options.phaseKey, options.jobs);
  const results = new Array<T>(options.jobs.length);
  const missing: Array<{ index: number; job: CheckpointJob<T>; inputHash: string }> = [];
  const reused: Array<{ job: CheckpointJob<T>; checkpoint: WorkCheckpoint<T> }> = [];

  for (let index = 0; index < options.jobs.length; index += 1) {
    const job = options.jobs[index];
    const inputHash = manifest.work[index].input_hash;
    const checkpoint = await readValidCheckpoint<T>(options.runDir, options.phaseKey, job.id, inputHash, options.validateOutput);
    if (!checkpoint) {
      missing.push({ index, job, inputHash });
      continue;
    }
    results[index] = checkpoint.output;
    reused.push({ job, checkpoint });
  }

  if (options.onResult && reused.length > 0) {
    function* reusedCallbacks() {
      for (const item of reused) {
        yield async (): Promise<void> => {
          await options.onResult!(item.checkpoint.output, {
            workId: item.job.id,
            reused: true,
            receiptUsage: item.checkpoint.usage
          });
        };
      }
    }
    // Receipt replay is local I/O, not provider work. Give it a separate bounded
    // fan-out so TraceStore can coalesce append-ready rows even when model
    // concurrency is deliberately one.
    await runLimitedPhase(reusedCallbacks(), Math.min(32, reused.length), { signal: options.signal });
  }

  function* pendingJobs() {
    for (const pending of missing) {
      yield async (signal: AbortSignal): Promise<{ index: number; output: T }> => {
        const output = await pending.job.run(signal);
        if (options.validateOutput && !options.validateOutput(output)) {
          throw new ConfigError(`Checkpoint job ${pending.job.id} produced an invalid output.`, {
            code: "trace.checkpoint_output_invalid",
            retryable: false
          });
        }
        const usage = pending.job.receiptUsage?.();
        await writeCheckpoint(options.runDir, options.phaseKey, pending.job.id, pending.inputHash, output, usage);
        await options.onResult?.(output, { workId: pending.job.id, reused: false, receiptUsage: usage });
        return { index: pending.index, output };
      };
    }
  }

  const completed = await runLimitedPhase(pendingJobs(), options.concurrency, { signal: options.signal });
  for (const item of completed) results[item.index] = item.output;
  if (results.some((value) => value === undefined)) {
    throw new ConfigError(`Phase ${options.phaseKey} did not produce every checkpointed result.`, {
      code: "trace.checkpoint_incomplete",
      retryable: true
    });
  }
  return results;
}

export async function writePhaseCommit(
  runDir: string,
  phaseKey: string,
  artifacts: Record<string, unknown>
): Promise<PhaseCommit> {
  await readJsonStrictOptional<PhaseCommit>(commitPath(runDir, phaseKey));
  const manifest = await readPhaseManifest(runDir, phaseKey);
  if (!manifest) throw traceIntegrityError(`Missing manifest for phase ${phaseKey}.`);
  validateManifest(manifest, phaseKey);
  const checkpointHashes: Record<string, string> = {};
  for (const work of manifest.work) {
    const checkpoint = await readValidCheckpoint(runDir, phaseKey, work.work_id, work.input_hash);
    if (!checkpoint) throw traceIntegrityError(`Missing or invalid checkpoint ${work.work_id} for phase ${phaseKey}.`);
    checkpointHashes[work.work_id] = checkpointBindingHash(checkpoint);
  }
  const commit: PhaseCommit = {
    schema_version: 2,
    phase_key: phaseKey,
    manifest_hash: manifest.manifest_hash,
    checkpoint_hashes: checkpointHashes,
    artifact_hashes: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, hashValue(value)])),
    committed_at: new Date().toISOString()
  };
  await writeJsonAtomic(commitPath(runDir, phaseKey), commit);
  return commit;
}

export async function validatePhaseCommit(
  runDir: string,
  phaseKey: string,
  artifacts?: Record<string, unknown>
): Promise<PhaseCommit> {
  const commit = await readJsonStrictOptional<PhaseCommit>(commitPath(runDir, phaseKey));
  if (!commit || commit.schema_version !== 2 || commit.phase_key !== phaseKey) {
    throw traceIntegrityError(`Missing or invalid phase commit for ${phaseKey}.`);
  }
  const manifest = await readPhaseManifest(runDir, phaseKey);
  if (!manifest) throw traceIntegrityError(`Missing manifest for committed phase ${phaseKey}.`);
  validateManifest(manifest, phaseKey);
  if (commit.manifest_hash !== manifest.manifest_hash) {
    throw traceIntegrityError(`Manifest hash changed for committed phase ${phaseKey}.`);
  }
  const expectedCheckpointHashes: Record<string, string> = {};
  for (const work of manifest.work) {
    const checkpoint = await readValidCheckpoint(runDir, phaseKey, work.work_id, work.input_hash);
    if (!checkpoint) throw traceIntegrityError(`Checkpoint ${work.work_id} is invalid for committed phase ${phaseKey}.`);
    expectedCheckpointHashes[work.work_id] = checkpointBindingHash(checkpoint);
  }
  if (stableJson(commit.checkpoint_hashes) !== stableJson(expectedCheckpointHashes)) {
    throw traceIntegrityError(`Checkpoint bindings changed for committed phase ${phaseKey}.`);
  }
  if (artifacts) {
    const expectedArtifacts = Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, hashValue(value)]));
    if (stableJson(commit.artifact_hashes) !== stableJson(expectedArtifacts)) {
      throw traceIntegrityError(`Artifact bindings changed for committed phase ${phaseKey}.`);
    }
  }
  return commit;
}

export async function validatePhaseCommitIfPresent(
  runDir: string,
  phaseKey: string,
  artifacts: Record<string, unknown>
): Promise<PhaseCommit | undefined> {
  const commit = await readJsonStrictOptional<PhaseCommit>(commitPath(runDir, phaseKey));
  if (!commit) return undefined;
  return validatePhaseCommit(runDir, phaseKey, artifacts);
}

export async function readValidatedPhaseReceiptUsage(runDir: string, phaseKey: string): Promise<unknown[]> {
  const manifest = await readPhaseManifest(runDir, phaseKey);
  if (!manifest) return [];
  validateManifest(manifest, phaseKey);
  const usage: unknown[] = [];
  for (const work of manifest.work) {
    const checkpoint = await readValidCheckpoint(runDir, phaseKey, work.work_id, work.input_hash);
    if (!checkpoint) continue;
    if (Array.isArray(checkpoint.usage)) usage.push(...checkpoint.usage);
  }
  return usage;
}

export function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function ensurePhaseManifest<T>(runDir: string, phaseKey: string, jobs: readonly CheckpointJob<T>[]): Promise<PhaseManifest> {
  const work = jobs.map((job) => ({ work_id: job.id, input_hash: hashValue(job.input) }));
  const manifestHash = hashValue({ schema_version: 2, phase_key: phaseKey, work });
  const existing = await readPhaseManifest(runDir, phaseKey);
  if (existing) {
    validateManifest(existing, phaseKey);
    if (existing.manifest_hash !== manifestHash || stableJson(existing.work) !== stableJson(work)) {
      throw traceIntegrityError(`Manifest inputs changed for phase ${phaseKey}.`);
    }
    return existing;
  }
  const manifest: PhaseManifest = {
    schema_version: 2,
    phase_key: phaseKey,
    manifest_hash: manifestHash,
    work,
    created_at: new Date().toISOString()
  };
  await writeJsonAtomic(manifestPath(runDir, phaseKey), manifest);
  return manifest;
}

async function readPhaseManifest(runDir: string, phaseKey: string): Promise<PhaseManifest | undefined> {
  return readJsonStrictOptional<PhaseManifest>(manifestPath(runDir, phaseKey));
}

function validateManifest(manifest: PhaseManifest, phaseKey: string): void {
  const workValid =
    Array.isArray(manifest.work) &&
    new Set(manifest.work.map((item) => item.work_id)).size === manifest.work.length &&
    manifest.work.every(
      (item) =>
        item &&
        typeof item.work_id === "string" &&
        item.work_id.length > 0 &&
        typeof item.input_hash === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(item.input_hash)
    );
  const expectedHash = hashValue({ schema_version: 2, phase_key: phaseKey, work: manifest.work });
  if (
    manifest.schema_version !== 2 ||
    manifest.phase_key !== phaseKey ||
    manifest.manifest_hash !== expectedHash ||
    !workValid
  ) {
    throw traceIntegrityError(`Manifest is invalid for phase ${phaseKey}.`);
  }
}

async function readValidCheckpoint<T>(
  runDir: string,
  phaseKey: string,
  workId: string,
  inputHash: string,
  validateOutput?: (output: unknown) => output is T
): Promise<WorkCheckpoint<T> | undefined> {
  const checkpoint = await readJson<WorkCheckpoint<T>>(checkpointPath(runDir, phaseKey, workId));
  if (!checkpoint) return undefined;
  if (
    checkpoint.schema_version !== 2 ||
    checkpoint.phase_key !== phaseKey ||
    checkpoint.work_id !== workId ||
    checkpoint.input_hash !== inputHash ||
    checkpoint.output_hash !== hashValue(checkpoint.output) ||
    checkpoint.usage_hash !== hashValue(checkpoint.usage ?? null) ||
    !/^sha256:[0-9a-f]{64}$/.test(checkpoint.output_hash) ||
    !/^sha256:[0-9a-f]{64}$/.test(checkpoint.usage_hash) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkpoint.attempt_id) ||
    typeof checkpoint.completed_at !== "string" ||
    !Number.isFinite(Date.parse(checkpoint.completed_at)) ||
    new Date(checkpoint.completed_at).toISOString() !== checkpoint.completed_at ||
    (validateOutput && !validateOutput(checkpoint.output))
  ) {
    return undefined;
  }
  if (!(await promptReferencesValid(runDir, checkpoint.output))) return undefined;
  return checkpoint;
}

async function promptReferencesValid(runDir: string, value: unknown): Promise<boolean> {
  const references: Array<{ sha256: string; path: string }> = [];
  collectPromptReferences(value, references);
  for (const reference of references) {
    if (!/^sha256:[0-9a-f]{64}$/.test(reference.sha256)) return false;
    const path = `artifacts/prompts/${reference.sha256.slice("sha256:".length)}.json`;
    if (reference.path !== path) return false;
    try {
      const raw = await readFile(join(runDir, path), "utf8");
      const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      if (digest !== reference.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function collectPromptReferences(value: unknown, out: Array<{ sha256: string; path: string }>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPromptReferences(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const promptRef = record.promptRef;
  if (promptRef && typeof promptRef === "object" && !Array.isArray(promptRef)) {
    const reference = promptRef as Record<string, unknown>;
    if (typeof reference.sha256 === "string" && typeof reference.path === "string") {
      out.push({ sha256: reference.sha256, path: reference.path });
    } else {
      out.push({ sha256: "invalid", path: "invalid" });
    }
  }
  for (const [key, inner] of Object.entries(record)) {
    if (key !== "promptRef") collectPromptReferences(inner, out);
  }
}

async function writeCheckpoint<T>(
  runDir: string,
  phaseKey: string,
  workId: string,
  inputHash: string,
  output: T,
  usage?: unknown
): Promise<void> {
  const checkpoint: WorkCheckpoint<T> = {
    schema_version: 2,
    phase_key: phaseKey,
    work_id: workId,
    input_hash: inputHash,
    output_hash: hashValue(output),
    output,
    usage,
    usage_hash: hashValue(usage ?? null),
    attempt_id: randomUUID(),
    completed_at: new Date().toISOString()
  };
  await writeJsonAtomic(checkpointPath(runDir, phaseKey, workId), checkpoint);
}

function checkpointBindingHash(checkpoint: WorkCheckpoint): string {
  return hashValue({
    schema_version: checkpoint.schema_version,
    phase_key: checkpoint.phase_key,
    work_id: checkpoint.work_id,
    input_hash: checkpoint.input_hash,
    output_hash: checkpoint.output_hash,
    usage_hash: checkpoint.usage_hash,
    attempt_id: checkpoint.attempt_id,
    completed_at: checkpoint.completed_at
  });
}

function assertUniqueWorkIds<T>(jobs: readonly CheckpointJob<T>[]): void {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job.id || ids.has(job.id)) {
      throw new ConfigError(`Checkpoint work IDs must be non-empty and unique; received ${job.id || "empty ID"}.`, {
        code: "trace.work_id_invalid",
        retryable: false
      });
    }
    ids.add(job.id);
  }
}

function manifestPath(runDir: string, phaseKey: string): string {
  return join(runDir, "manifests", `${phaseFileKey(phaseKey)}.json`);
}

function commitPath(runDir: string, phaseKey: string): string {
  return join(runDir, "commits", `${phaseFileKey(phaseKey)}.json`);
}

function checkpointPath(runDir: string, phaseKey: string, workId: string): string {
  return join(runDir, "checkpoints", phaseFileKey(phaseKey), `${hashValue(workId).slice("sha256:".length)}.json`);
}

function phaseFileKey(phaseKey: string): string {
  return encodeURIComponent(phaseKey).replaceAll("%", "_");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function readJsonStrictOptional<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw traceIntegrityError(`Could not parse ${path}: ${(error as Error).message}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function traceIntegrityError(message: string): ConfigError {
  return new ConfigError(message, {
    code: "resume.trace_v2_integrity",
    retryable: false,
    fix: "Restore the matching manifest/checkpoint/commit files, or start a fresh run."
  });
}
