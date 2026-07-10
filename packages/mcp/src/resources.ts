import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ConfigError, detectResumeState, exportRun, listRunRecords, readRunStatus, recordRunIndex, resolveRunDir, runArtifactFiles, runIdSchema, type RunArtifactName } from "@deepthonk/core";

export const MAX_RESOURCE_BYTES = 1_000_000;
export const MAX_RESOURCE_PAGE_RECORDS = 1_000;
export const MAX_LISTED_RESOURCES = 100;

const runResources = ["summary", "config", "candidates", "comparisons", "scores", "usage", "trace", "final", "winner", "status"] as const;
const jobResources = ["status", "result", "config", "candidates", "comparisons", "scores", "usage", "trace", "final", "winner"] as const;

export const resourceTemplates = [
  "deepthonk://runs",
  "deepthonk://runs/page/{cursor}",
  "deepthonk://runs/{run_id}/summary",
  "deepthonk://runs/{run_id}/config",
  "deepthonk://runs/{run_id}/candidates",
  "deepthonk://runs/{run_id}/comparisons",
  "deepthonk://runs/{run_id}/scores",
  "deepthonk://runs/{run_id}/usage",
  "deepthonk://runs/{run_id}/trace",
  "deepthonk://runs/{run_id}/final",
  "deepthonk://runs/{run_id}/winner",
  "deepthonk://runs/{run_id}/status",
  "deepthonk://runs/{run_id}/population/{generation}",
  "deepthonk://runs/{run_id}/prompts/{sha256}",
  "deepthonk://runs/{run_id}/prompts/{sha256}/page/{cursor}",
  "deepthonk://runs/{run_id}/trace-v2",
  "deepthonk://runs/{run_id}/trace-v2/page/{cursor}",
  "deepthonk://runs/{run_id}/trace-v2/manifests/{phase_id}",
  "deepthonk://runs/{run_id}/trace-v2/manifests/{phase_id}/page/{cursor}",
  "deepthonk://runs/{run_id}/trace-v2/commits/{phase_id}",
  "deepthonk://runs/{run_id}/trace-v2/commits/{phase_id}/page/{cursor}",
  "deepthonk://runs/{run_id}/trace-v2/checkpoints/{phase_id}",
  "deepthonk://runs/{run_id}/trace-v2/checkpoints/{phase_id}/page/{cursor}",
  "deepthonk://runs/{run_id}/trace-v2/checkpoints/{phase_id}/{checkpoint_id}",
  "deepthonk://runs/{run_id}/trace-v2/checkpoints/{phase_id}/{checkpoint_id}/page/{cursor}",
  "deepthonk://runs/{run_id}/{resource}/page/{cursor}",
  "deepthonk://runs/{run_id}/population/{generation}/page/{cursor}",
  "deepthonk://jobs/{job_id}/status",
  "deepthonk://jobs/{job_id}/result",
  "deepthonk://jobs/{job_id}/config",
  "deepthonk://jobs/{job_id}/candidates",
  "deepthonk://jobs/{job_id}/comparisons",
  "deepthonk://jobs/{job_id}/scores",
  "deepthonk://jobs/{job_id}/usage",
  "deepthonk://jobs/{job_id}/trace",
  "deepthonk://jobs/{job_id}/final",
  "deepthonk://jobs/{job_id}/winner",
  "deepthonk://jobs/{job_id}/population/{generation}",
  "deepthonk://jobs/{job_id}/prompts/{sha256}",
  "deepthonk://jobs/{job_id}/prompts/{sha256}/page/{cursor}",
  "deepthonk://jobs/{job_id}/trace-v2",
  "deepthonk://jobs/{job_id}/trace-v2/page/{cursor}",
  "deepthonk://jobs/{job_id}/trace-v2/manifests/{phase_id}",
  "deepthonk://jobs/{job_id}/trace-v2/manifests/{phase_id}/page/{cursor}",
  "deepthonk://jobs/{job_id}/trace-v2/commits/{phase_id}",
  "deepthonk://jobs/{job_id}/trace-v2/commits/{phase_id}/page/{cursor}",
  "deepthonk://jobs/{job_id}/trace-v2/checkpoints/{phase_id}",
  "deepthonk://jobs/{job_id}/trace-v2/checkpoints/{phase_id}/page/{cursor}",
  "deepthonk://jobs/{job_id}/trace-v2/checkpoints/{phase_id}/{checkpoint_id}",
  "deepthonk://jobs/{job_id}/trace-v2/checkpoints/{phase_id}/{checkpoint_id}/page/{cursor}"
] as const;

export function jobArtifactResources(jobId: string, runDir: string): Record<string, string> {
  const encodedRunDir = encodeURIComponent(runDir);
  return {
    ...Object.fromEntries(jobResources.map((resource) => [resource, `deepthonk://jobs/${jobId}/${resource}?run_dir=${encodedRunDir}`])),
    population_template: `deepthonk://jobs/${jobId}/population/{generation}?run_dir=${encodedRunDir}`,
    prompt_template: `deepthonk://jobs/${jobId}/prompts/{sha256}?run_dir=${encodedRunDir}`,
    trace_v2_template: `deepthonk://jobs/${jobId}/trace-v2?run_dir=${encodedRunDir}`,
    page_template: `deepthonk://jobs/${jobId}/{resource}/page/{cursor}?run_dir=${encodedRunDir}`,
    population_page_template: `deepthonk://jobs/${jobId}/population/{generation}/page/{cursor}?run_dir=${encodedRunDir}`
  };
}

export async function readRunResource(uri: string, runsRoot = "runs"): Promise<string> {
  if (uri === "deepthonk://runs") {
    const records = await listRunRecords(runsRoot);
    const encoded = JSON.stringify(records);
    if (Buffer.byteLength(encoded, "utf8") <= MAX_RESOURCE_BYTES) return encoded;
    return pagePayload(records, 0);
  }
  const runsPageMatch = uri.match(/^deepthonk:\/\/runs\/page\/([^/]+)$/);
  if (runsPageMatch) return pagePayload(await listRunRecords(runsRoot), decodeCursor(runsPageMatch[1]));
  const parsed = new URL(uri);
  const segments = parsed.pathname.replace(/^\/+/, "").split("/");
  if (parsed.hostname === "runs" && segments.length >= 2 && (segments[1] === "prompts" || segments[1] === "trace-v2")) {
    const runId = validatedRunId(segments[0]);
    const base = await resolveRunDir(runId, runsRoot);
    return readSpecialResource(base, segments.slice(1), `deepthonk://runs/${encodeURIComponent(runId)}`);
  }
  const pageMatch = uri.match(/^deepthonk:\/\/runs\/([^/]+)\/(population\/[^/]+|[^/]+)\/page\/([^/]+)$/);
  if (pageMatch) {
    const [, rawRunId, resourcePath, cursor] = pageMatch;
    const runId = validatedRunId(rawRunId);
    const base = await resolveRunDir(runId, runsRoot);
    return readResourcePage(resourceFile(base, resourcePath), decodeCursor(cursor));
  }
  const populationMatch = uri.match(/^deepthonk:\/\/runs\/([^/]+)\/population\/([^/]+)$/);
  if (populationMatch) {
    const [, rawRunId, generation] = populationMatch;
    const runId = validatedRunId(rawRunId);
    const base = await resolveRunDir(runId, runsRoot);
    return readWholeResource(join(base, `population-${generation}.json`), firstPageUri(runId, `population/${generation}`));
  }
  const match = uri.match(/^deepthonk:\/\/runs\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`Unsupported resource URI: ${uri}`);
  const [, rawRunId, resource] = match;
  const runId = validatedRunId(rawRunId);
  const base = await resolveRunDir(runId, runsRoot);
  const artifact = resourceArtifact(resource);
  const path = join(base, runArtifactFiles[artifact]);
  return readWholeResource(path, firstPageUri(runId, resource));
}

export async function readJobResource(uri: string): Promise<string> {
  const parsed = new URL(uri);
  const segments = parsed.pathname.replace(/^\/+/, "").split("/");
  const requestedJobId = parsed.hostname === "jobs" ? segments[0] : undefined;
  const runDir = parsed.searchParams.get("run_dir");
  const [, resource, generation] = segments;
  if (!runDir) throw new Error(`Job resource requires run_dir query: ${uri}`);
  const status = await readRunStatus(runDir);
  if (!requestedJobId || !status?.job_id || requestedJobId !== status.job_id) {
    throw new ConfigError(`Job ID mismatch: requested ${requestedJobId ?? "missing"}, run directory belongs to ${status?.job_id ?? "no recorded job"}.`, {
      code: "mcp.job_mismatch",
      retryable: false,
      fix: "Use the job_id and run_dir pair returned by deepthonk.start."
    });
  }
  if (resource === "prompts" || resource === "trace-v2") {
    const prefix = `deepthonk://jobs/${encodeURIComponent(requestedJobId)}`;
    return readSpecialResource(runDir, segments.slice(1), prefix, runDir);
  }
  if (resource === "population" && segments[3] === "page" && segments[4]) {
    if (!generation || !/^\d+$/.test(generation)) throw new Error(`Job population resource requires generation: ${uri}`);
    return readResourcePage(join(runDir, `population-${generation}.json`), decodeCursor(segments[4]));
  }
  if (segments[2] === "page" && segments[3] && isRunResource(resource)) {
    return readResourcePage(join(runDir, runArtifactFiles[resourceArtifact(resource)]), decodeCursor(segments[3]));
  }
  if (resource === "status") {
    return boundedJobJson(
      status ?? (await detectResumeState(runDir)),
      firstJobPageUri(requestedJobId, "status", runDir)
    );
  }
  if (resource === "result") {
    const resume = await detectResumeState(runDir);
    if (resume.status !== "completed") {
      const pending = { complete: false, run_dir: runDir, status: status ?? resume };
      const encodedPending = JSON.stringify(pending);
      if (Buffer.byteLength(encodedPending, "utf8") <= MAX_RESOURCE_BYTES) return encodedPending;
      return JSON.stringify({
        complete: false,
        run_dir: runDir,
        status_omitted: true,
        status_resource: `deepthonk://jobs/${requestedJobId}/status?run_dir=${encodeURIComponent(runDir)}`
      }, null, 2);
    }
    const completed = { complete: true, run_dir: runDir, summary: await exportRun(runDir, "json") };
    const encodedCompleted = JSON.stringify(completed);
    if (Buffer.byteLength(encodedCompleted, "utf8") <= MAX_RESOURCE_BYTES) return encodedCompleted;
    return JSON.stringify({
      complete: true,
      run_dir: runDir,
      summary_omitted: true,
      summary_resource: `deepthonk://jobs/${requestedJobId}/summary?run_dir=${encodeURIComponent(runDir)}`
    }, null, 2);
  }
  if (resource === "population") {
    if (!generation) throw new Error(`Job population resource requires generation: ${uri}`);
    return readWholeResource(join(runDir, `population-${generation}.json`), firstJobPageUri(requestedJobId ?? "unknown", `population/${generation}`, runDir));
  }
  if (isRunResource(resource)) {
    const artifact = resourceArtifact(resource);
    return readWholeResource(join(runDir, runArtifactFiles[artifact]), firstJobPageUri(requestedJobId ?? "unknown", resource, runDir));
  }
  throw new Error(`Unsupported job resource: ${resource}`);
}

export async function recordRunResource(runId: string, runDir: string, runsRoot = "runs"): Promise<void> {
  await recordRunIndex(runId, runDir, runsRoot);
}

export async function listRunResources(runsRoot = "runs"): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const records = (await listRunRecords(runsRoot)).reverse();
  const listed: Array<{ uri: string; name: string; title: string; mimeType: string }> = [];
  for (const record of records) {
    const remaining = MAX_LISTED_RESOURCES - listed.length;
    if (remaining <= 0) break;
    listed.push(...runResources.slice(0, remaining).map((resource) => ({
      uri: `deepthonk://runs/${record.run_id}/${resource}`,
      name: `${record.run_id}/${resource}`,
      title: `DeepThonk ${resource} for ${record.run_id}`,
      mimeType: resourceMimeType(resource)
    })));
    if (listed.length < MAX_LISTED_RESOURCES) {
      listed.push(...(await listRunPopulationResourcesForRecord(record.run_id, record.run_dir, MAX_LISTED_RESOURCES - listed.length)));
    }
  }
  return listed;
}

export async function listRunPopulationResources(runsRoot = "runs"): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const records = (await listRunRecords(runsRoot)).reverse();
  const listed: Array<{ uri: string; name: string; title: string; mimeType: string }> = [];
  for (const record of records) {
    if (listed.length >= MAX_LISTED_RESOURCES) break;
    listed.push(...(await listRunPopulationResourcesForRecord(record.run_id, record.run_dir, MAX_LISTED_RESOURCES - listed.length)));
  }
  return listed;
}

function resourceMimeType(resource: string): string {
  if (resource === "summary") return "application/json";
  if (resource === "config") return "application/json";
  if (resource === "status") return "application/json";
  if (resource === "population") return "application/json";
  if (resource === "final" || resource === "winner") return "text/plain";
  return "application/x-ndjson";
}

export function runResourceMimeType(resource: string): string {
  return resourceMimeType(resource);
}

export function jobResourceMimeType(resource: string): string {
  if (resource === "result") return "application/json";
  return resourceMimeType(resource);
}

export function jobResourceName(uri: string): string {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\/+/, "").split("/")[1] ?? "status";
}

function resourceArtifact(resource: string): RunArtifactName {
  switch (resource) {
    case "summary":
      return "summary";
    case "config":
      return "config";
    case "candidates":
      return "candidates";
    case "comparisons":
      return "comparisons";
    case "scores":
      return "scores";
    case "usage":
      return "usage";
    case "trace":
      return "trace";
    case "final":
      return "final";
    case "winner":
      return "winner";
    case "status":
      return "status";
    default:
      throw new Error(`Unsupported run resource: ${resource}`);
  }
}

function isRunResource(resource: string | undefined): resource is (typeof runResources)[number] {
  return Boolean(resource && (runResources as readonly string[]).includes(resource));
}

async function listRunPopulationResourcesForRecord(
  runId: string,
  runDir: string,
  limit = MAX_LISTED_RESOURCES
): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const files = await readdir(runDir).catch(() => []);
  return files
    .map((file) => /^population-(\d+)\.json$/.exec(file)?.[1])
    .filter((generation): generation is string => generation !== undefined)
    .sort((left, right) => Number(left) - Number(right))
    .slice(0, limit)
    .map((generation) => ({
      uri: `deepthonk://runs/${runId}/population/${generation}`,
      name: `${runId}/population/${generation}`,
      title: `DeepThonk population ${generation} for ${runId}`,
      mimeType: "application/json"
    }));
}

async function readWholeResource(path: string, pageUri: string): Promise<string> {
  const info = await stat(path);
  if (info.size > MAX_RESOURCE_BYTES) {
    throw new ConfigError(`Resource is ${info.size} bytes; whole-resource reads are limited to ${MAX_RESOURCE_BYTES} bytes.`, {
      code: "mcp.resource_too_large",
      retryable: false,
      fix: `Read the first bounded page at ${pageUri}`
    });
  }
  return readFile(path, "utf8");
}

async function readResourcePage(path: string, offset: number): Promise<string> {
  if (path.endsWith(".jsonl")) return readJsonlPage(path, offset);
  if (/[/\\]population-\d+\.json$/.test(path)) return readJsonArrayPage(path, offset);
  return readBytePage(path, offset);
}

async function readBytePage(path: string, offset: number): Promise<string> {
  const info = await stat(path);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size) throw invalidCursorError();
  const maxRawBytes = 700_000;
  const length = Math.min(maxRawBytes, info.size - offset);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, offset));
  } finally {
    await handle.close();
  }
  const nextOffset = offset + bytesRead;
  return boundedResourcePage({
    encoding: "base64",
    data: buffer.subarray(0, bytesRead).toString("base64"),
    next_cursor: nextOffset < info.size ? encodeCursor(nextOffset) : undefined
  });
}

async function readJsonArrayPage(path: string, offset: number): Promise<string> {
  const records: unknown[] = [];
  let index = 0;
  let hasMore = false;
  for await (const value of streamJsonArray(path)) {
    if (index++ < offset) continue;
    if (records.length >= MAX_RESOURCE_PAGE_RECORDS || !fitsPage([...records, value], offset + records.length + 1)) {
      hasMore = true;
      break;
    }
    records.push(value);
  }
  if (records.length === 0 && hasMore) throw oversizedRecordError();
  return boundedPageJson({ records, next_cursor: hasMore ? encodeCursor(offset + records.length) : undefined });
}

async function* streamJsonArray(path: string): AsyncGenerator<unknown> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let arrayStarted = false;
  let arrayEnded = false;
  let collecting = false;
  let item = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunkValue of stream) {
    const chunk = String(chunkValue);
    for (const character of chunk) {
      if (!arrayStarted) {
        if (/\s/.test(character)) continue;
        if (character !== "[") throw new Error(`Expected a top-level JSON array in ${path}.`);
        arrayStarted = true;
        continue;
      }
      if (arrayEnded) {
        if (!/\s/.test(character)) throw new Error(`Unexpected data after JSON array in ${path}.`);
        continue;
      }
      if (!collecting) {
        if (/\s/.test(character) || character === ",") continue;
        if (character === "]") {
          arrayEnded = true;
          continue;
        }
        collecting = true;
        item = "";
        depth = 0;
        inString = false;
        escaped = false;
      }

      if (inString) {
        item += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        item += character;
        continue;
      }
      if (character === "{" || character === "[") {
        depth += 1;
        item += character;
        continue;
      }
      if (character === "}") {
        depth -= 1;
        item += character;
        continue;
      }
      if (character === "]") {
        if (depth > 0) {
          depth -= 1;
          item += character;
          continue;
        }
        if (item.trim()) yield JSON.parse(item) as unknown;
        collecting = false;
        arrayEnded = true;
        continue;
      }
      if (character === "," && depth === 0) {
        yield JSON.parse(item) as unknown;
        collecting = false;
        item = "";
        continue;
      }
      item += character;
    }
  }
  if (!arrayStarted || !arrayEnded || collecting || inString || depth !== 0) throw new Error(`Incomplete JSON array in ${path}.`);
}

async function readJsonlPage(path: string, offset: number): Promise<string> {
  const records: unknown[] = [];
  let index = 0;
  let hasMore = false;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (index++ < offset) continue;
    const value = JSON.parse(line) as unknown;
    if (records.length >= MAX_RESOURCE_PAGE_RECORDS || !fitsPage([...records, value], offset + records.length + 1)) {
      hasMore = true;
      break;
    }
    records.push(value);
  }
  if (records.length === 0 && hasMore) throw oversizedRecordError();
  return boundedPageJson({ records, next_cursor: hasMore ? encodeCursor(offset + records.length) : undefined });
}

function pagePayload(values: readonly unknown[], offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) throw invalidCursorError();
  const records: unknown[] = [];
  let index = offset;
  while (index < values.length && records.length < MAX_RESOURCE_PAGE_RECORDS) {
    const value = values[index];
    if (!fitsPage([...records, value], index + 1)) break;
    records.push(value);
    index += 1;
  }
  if (records.length === 0 && index < values.length) throw oversizedRecordError();
  return boundedPageJson({ records, next_cursor: index < values.length ? encodeCursor(index) : undefined });
}

function boundedPageJson(value: { records: unknown[]; next_cursor?: string }): string {
  return boundedResourcePage(value);
}

function boundedResourcePage(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESOURCE_BYTES) {
    throw new ConfigError(`Resource page exceeds the ${MAX_RESOURCE_BYTES}-byte limit.`, {
      code: "mcp.resource_page_too_large",
      retryable: false,
      fix: "Read a smaller page or reduce the size of stored records."
    });
  }
  return encoded;
}

function fitsPage(records: readonly unknown[], nextOffset: number): boolean {
  return Buffer.byteLength(JSON.stringify({ records, next_cursor: encodeCursor(nextOffset) }), "utf8") <= MAX_RESOURCE_BYTES;
}

function firstPageUri(runId: string, resourcePath: string): string {
  return `deepthonk://runs/${runId}/${resourcePath}/page/${encodeCursor(0)}`;
}

function firstJobPageUri(jobId: string, resourcePath: string, runDir: string): string {
  return `deepthonk://jobs/${jobId}/${resourcePath}/page/${encodeCursor(0)}?run_dir=${encodeURIComponent(runDir)}`;
}

function boundedJobJson(value: unknown, pageUri: string): string {
  const compact = JSON.stringify(value);
  if (Buffer.byteLength(compact, "utf8") > MAX_RESOURCE_BYTES) {
    throw new ConfigError(`Job resource exceeds the ${MAX_RESOURCE_BYTES}-byte whole-read limit.`, {
      code: "mcp.resource_too_large",
      retryable: false,
      fix: `Read the first bounded page at ${pageUri}`
    });
  }
  return compact;
}

async function readSpecialResource(
  runDir: string,
  segments: string[],
  scopePrefix: string,
  jobRunDir?: string
): Promise<string> {
  if (segments[0] === "prompts") {
    const sha256 = validatedPromptSha(segments[1]);
    const pageCursor = segments[2] === "page" && segments[3] ? decodeCursor(segments[3]) : undefined;
    if (segments.length !== (pageCursor === undefined ? 2 : 4)) throw unsupportedSpecialResource(segments);
    const baseUri = `${scopePrefix}/prompts/${encodeURIComponent(sha256)}`;
    return readPromptBlob(runDir, sha256, pageCursor, scopedUri(`${baseUri}/page/${encodeCursor(0)}`, jobRunDir));
  }
  if (segments[0] !== "trace-v2") throw unsupportedSpecialResource(segments);

  const tracePrefix = `${scopePrefix}/trace-v2`;
  if (segments.length === 1) return traceV2PhaseIndex(runDir, tracePrefix, jobRunDir, 0);
  if (segments[1] === "page" && segments[2] && segments.length === 3) {
    return traceV2PhaseIndex(runDir, tracePrefix, jobRunDir, decodeCursor(segments[2]));
  }

  const kind = segments[1];
  const phaseId = validatedPhaseId(segments[2]);
  if (kind === "manifests" || kind === "commits") {
    const pageCursor = segments[3] === "page" && segments[4] ? decodeCursor(segments[4]) : undefined;
    if (segments.length !== (pageCursor === undefined ? 3 : 5)) throw unsupportedSpecialResource(segments);
    const path = join(runDir, kind, `${phaseId}.json`);
    const baseUri = `${tracePrefix}/${kind}/${phaseId}`;
    return pageCursor === undefined
      ? readWholeResource(path, scopedUri(`${baseUri}/page/${encodeCursor(0)}`, jobRunDir))
      : readResourcePage(path, pageCursor);
  }
  if (kind !== "checkpoints") throw unsupportedSpecialResource(segments);
  if (segments.length === 3) return checkpointIndex(runDir, phaseId, tracePrefix, jobRunDir, 0);
  if (segments[3] === "page" && segments[4] && segments.length === 5) {
    return checkpointIndex(runDir, phaseId, tracePrefix, jobRunDir, decodeCursor(segments[4]));
  }
  const checkpointId = validatedCheckpointId(segments[3]);
  const pageCursor = segments[4] === "page" && segments[5] ? decodeCursor(segments[5]) : undefined;
  if (segments.length !== (pageCursor === undefined ? 4 : 6)) throw unsupportedSpecialResource(segments);
  const path = join(runDir, "checkpoints", phaseId, `${checkpointId}.json`);
  const baseUri = `${tracePrefix}/checkpoints/${phaseId}/${checkpointId}`;
  return pageCursor === undefined
    ? readWholeResource(path, scopedUri(`${baseUri}/page/${encodeCursor(0)}`, jobRunDir))
    : readResourcePage(path, pageCursor);
}

async function readPromptBlob(
  runDir: string,
  sha256: string,
  pageCursor: number | undefined,
  firstPage: string
): Promise<string> {
  const path = join(runDir, "artifacts", "prompts", `${sha256.slice("sha256:".length)}.json`);
  await assertFileHash(path, sha256);
  return pageCursor === undefined ? readWholeResource(path, firstPage) : readResourcePage(path, pageCursor);
}

async function assertFileHash(path: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const actual = `sha256:${hash.digest("hex")}`;
  if (actual !== expected) {
    throw new ConfigError(`Prompt blob hash mismatch: expected ${expected}, received ${actual}.`, {
      code: "mcp.prompt_hash_mismatch",
      retryable: false,
      fix: "Restore the prompt blob matching the promptRef digest."
    });
  }
}

async function traceV2PhaseIndex(
  runDir: string,
  tracePrefix: string,
  jobRunDir: string | undefined,
  offset: number
): Promise<string> {
  const phaseIds = new Set<string>();
  for (const directory of ["manifests", "commits"] as const) {
    for (const file of await readdir(join(runDir, directory)).catch(() => [])) {
      const match = /^([A-Za-z0-9._~-]{1,256})\.json$/.exec(file);
      if (match) phaseIds.add(match[1]);
    }
  }
  for (const entry of await readdir(join(runDir, "checkpoints"), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && /^[A-Za-z0-9._~-]{1,256}$/.test(entry.name)) phaseIds.add(entry.name);
  }
  const records = [...phaseIds].sort().map((phaseId) => ({
    phase_id: phaseId,
    manifest_uri: scopedUri(`${tracePrefix}/manifests/${phaseId}`, jobRunDir),
    commit_uri: scopedUri(`${tracePrefix}/commits/${phaseId}`, jobRunDir),
    checkpoints_uri: scopedUri(`${tracePrefix}/checkpoints/${phaseId}`, jobRunDir)
  }));
  return pagePayload(records, offset);
}

async function checkpointIndex(
  runDir: string,
  phaseId: string,
  tracePrefix: string,
  jobRunDir: string | undefined,
  offset: number
): Promise<string> {
  const records = (await readdir(join(runDir, "checkpoints", phaseId)).catch(() => []))
    .flatMap((file) => {
      const match = /^([0-9a-f]{64})\.json$/.exec(file);
      return match ? [{ checkpoint_id: match[1], uri: scopedUri(`${tracePrefix}/checkpoints/${phaseId}/${match[1]}`, jobRunDir) }] : [];
    })
    .sort((left, right) => left.checkpoint_id.localeCompare(right.checkpoint_id));
  return pagePayload(records, offset);
}

function scopedUri(uri: string, runDir?: string): string {
  return runDir ? `${uri}?run_dir=${encodeURIComponent(runDir)}` : uri;
}

function validatedPromptSha(value: string | undefined): string {
  const decoded = decodePathSegment(value, "prompt SHA-256");
  if (!/^sha256:[0-9a-f]{64}$/.test(decoded)) {
    throw new ConfigError("Invalid prompt SHA-256 in resource URI.", {
      code: "mcp.invalid_prompt_hash",
      retryable: false,
      fix: "Use metadata.promptRef.sha256 exactly as returned by DeepThonk."
    });
  }
  return decoded;
}

function validatedPhaseId(value: string | undefined): string {
  const decoded = decodePathSegment(value, "trace-v2 phase ID");
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(decoded)) {
    throw new ConfigError("Invalid trace-v2 phase ID in resource URI.", {
      code: "mcp.invalid_trace_phase",
      retryable: false,
      fix: "Use a phase_id returned by the trace-v2 index resource."
    });
  }
  return decoded;
}

function validatedCheckpointId(value: string | undefined): string {
  const decoded = decodePathSegment(value, "checkpoint ID");
  if (!/^[0-9a-f]{64}$/.test(decoded)) {
    throw new ConfigError("Invalid trace-v2 checkpoint ID in resource URI.", {
      code: "mcp.invalid_checkpoint_id",
      retryable: false,
      fix: "Use a checkpoint_id returned by the phase checkpoint index."
    });
  }
  return decoded;
}

function decodePathSegment(value: string | undefined, label: string): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new ConfigError(`Invalid encoded ${label} in resource URI.`, { code: "mcp.invalid_resource_path", retryable: false });
  }
}

function unsupportedSpecialResource(segments: string[]): ConfigError {
  return new ConfigError(`Unsupported bounded resource path: ${segments.join("/")}.`, {
    code: "mcp.unsupported_resource",
    retryable: false
  });
}

function resourceFile(runDir: string, resourcePath: string): string {
  if (resourcePath.startsWith("population/")) {
    const generation = resourcePath.slice("population/".length);
    if (!/^\d+$/.test(generation)) throw new Error(`Unsupported population generation: ${generation}`);
    return join(runDir, `population-${generation}.json`);
  }
  return join(runDir, runArtifactFiles[resourceArtifact(resourcePath)]);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), "utf8").toString("base64url");
}

function validatedRunId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ConfigError("Invalid encoded run ID in resource URI.", { code: "mcp.invalid_run_id", retryable: false });
  }
  const parsed = runIdSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ConfigError(`Invalid run ID in resource URI: ${decoded}.`, {
      code: "mcp.invalid_run_id",
      retryable: false,
      fix: "Use the run_id returned by DeepThonk without path separators."
    });
  }
  return parsed.data;
}

function decodeCursor(cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; o?: unknown };
    if (value.v !== 1 || !Number.isSafeInteger(value.o) || Number(value.o) < 0) throw invalidCursorError();
    return Number(value.o);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw invalidCursorError();
  }
}

function invalidCursorError(): ConfigError {
  return new ConfigError("Invalid or expired resource page cursor.", {
    code: "mcp.invalid_resource_cursor",
    retryable: false,
    fix: "Start again from the first page URI returned by the whole-resource error."
  });
}

function oversizedRecordError(): ConfigError {
  return new ConfigError(`A single resource record exceeds the ${MAX_RESOURCE_BYTES}-byte page limit.`, {
    code: "mcp.resource_record_too_large",
    retryable: false,
    fix: "Reduce stored prompt/raw-output size or inspect the artifact directly on disk."
  });
}
