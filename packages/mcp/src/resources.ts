import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, detectResumeState, exportRun, listRunRecords, readRunArtifact, readRunStatus, recordRunIndex, resolveRunDir, type RunArtifactName } from "@deepthonk/core";

const runResources = ["summary", "config", "candidates", "comparisons", "scores", "usage", "trace", "final", "winner", "status"] as const;
const jobResources = ["status", "result", "config", "candidates", "comparisons", "scores", "usage", "trace", "final", "winner"] as const;

export const resourceTemplates = [
  "deepthonk://runs",
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
  "deepthonk://jobs/{job_id}/population/{generation}"
] as const;

export function jobArtifactResources(jobId: string, runDir: string): Record<string, string> {
  const encodedRunDir = encodeURIComponent(runDir);
  return {
    ...Object.fromEntries(jobResources.map((resource) => [resource, `deepthonk://jobs/${jobId}/${resource}?run_dir=${encodedRunDir}`])),
    population_template: `deepthonk://jobs/${jobId}/population/{generation}?run_dir=${encodedRunDir}`
  };
}

export async function readRunResource(uri: string, runsRoot = "runs"): Promise<string> {
  if (uri === "deepthonk://runs") {
    return JSON.stringify(await listRunRecords(runsRoot), null, 2);
  }
  const populationMatch = uri.match(/^deepthonk:\/\/runs\/([^/]+)\/population\/([^/]+)$/);
  if (populationMatch) {
    const [, runId, generation] = populationMatch;
    const base = await resolveRunDir(runId, runsRoot);
    return readFile(join(base, `population-${generation}.json`), "utf8");
  }
  const match = uri.match(/^deepthonk:\/\/runs\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`Unsupported resource URI: ${uri}`);
  const [, runId, resource] = match;
  const base = await resolveRunDir(runId, runsRoot);
  return readRunArtifact(base, resourceArtifact(resource));
}

export async function readJobResource(uri: string): Promise<string> {
  const parsed = new URL(uri);
  const segments = parsed.pathname.replace(/^\/+/, "").split("/");
  const requestedJobId = parsed.hostname === "jobs" ? segments[0] : undefined;
  const runDir = parsed.searchParams.get("run_dir");
  const [, resource, generation] = segments;
  if (!runDir) throw new Error(`Job resource requires run_dir query: ${uri}`);
  const status = await readRunStatus(runDir);
  if (requestedJobId && status?.job_id && requestedJobId !== status.job_id) {
    throw new ConfigError(`Job ID mismatch: requested ${requestedJobId}, run directory belongs to ${status.job_id}.`, {
      code: "mcp.job_mismatch",
      retryable: false,
      fix: "Use the job_id returned with this run_dir."
    });
  }
  if (resource === "status") {
    return JSON.stringify(status ?? (await detectResumeState(runDir)), null, 2);
  }
  if (resource === "result") {
    const resume = await detectResumeState(runDir);
    if (resume.status !== "completed") {
      return JSON.stringify({ complete: false, run_dir: runDir, status: status ?? resume }, null, 2);
    }
    return JSON.stringify({ complete: true, run_dir: runDir, summary: await exportRun(runDir, "json") }, null, 2);
  }
  if (resource === "population") {
    if (!generation) throw new Error(`Job population resource requires generation: ${uri}`);
    return readFile(join(runDir, `population-${generation}.json`), "utf8");
  }
  if (isRunResource(resource)) return readRunArtifact(runDir, resourceArtifact(resource));
  throw new Error(`Unsupported job resource: ${resource}`);
}

export async function recordRunResource(runId: string, runDir: string, runsRoot = "runs"): Promise<void> {
  await recordRunIndex(runId, runDir, runsRoot);
}

export async function listRunResources(runsRoot = "runs"): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const records = await listRunRecords(runsRoot);
  const listed: Array<{ uri: string; name: string; title: string; mimeType: string }> = [];
  for (const record of records) {
    listed.push(...runResources.map((resource) => ({
      uri: `deepthonk://runs/${record.run_id}/${resource}`,
      name: `${record.run_id}/${resource}`,
      title: `DeepThonk ${resource} for ${record.run_id}`,
      mimeType: resourceMimeType(resource)
    })));
    listed.push(...(await listRunPopulationResourcesForRecord(record.run_id, record.run_dir)));
  }
  return listed;
}

export async function listRunPopulationResources(runsRoot = "runs"): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const records = await listRunRecords(runsRoot);
  const listed: Array<{ uri: string; name: string; title: string; mimeType: string }> = [];
  for (const record of records) listed.push(...(await listRunPopulationResourcesForRecord(record.run_id, record.run_dir)));
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
  runDir: string
): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const files = await readdir(runDir).catch(() => []);
  return files
    .map((file) => /^population-(\d+)\.json$/.exec(file)?.[1])
    .filter((generation): generation is string => generation !== undefined)
    .sort((left, right) => Number(left) - Number(right))
    .map((generation) => ({
      uri: `deepthonk://runs/${runId}/population/${generation}`,
      name: `${runId}/population/${generation}`,
      title: `DeepThonk population ${generation} for ${runId}`,
      mimeType: "application/json"
    }));
}
