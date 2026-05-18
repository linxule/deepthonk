import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, detectResumeState, exportRun, listRunRecords, readRunArtifact, readRunStatus, recordRunIndex, resolveRunDir, type RunArtifactName } from "@deepthonk/core";

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
  "deepthonk://jobs/{job_id}/result"
] as const;

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
  const requestedJobId = parsed.hostname === "jobs" ? parsed.pathname.replace(/^\/+/, "").split("/")[0] : undefined;
  const runDir = parsed.searchParams.get("run_dir");
  const [, resource] = parsed.pathname.replace(/^\/+/, "").split("/");
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
  throw new Error(`Unsupported job resource: ${resource}`);
}

export async function recordRunResource(runId: string, runDir: string, runsRoot = "runs"): Promise<void> {
  await recordRunIndex(runId, runDir, runsRoot);
}

export async function listRunResources(runsRoot = "runs"): Promise<Array<{ uri: string; name: string; title: string; mimeType: string }>> {
  const records = await listRunRecords(runsRoot);
  const resources = ["summary", "config", "candidates", "comparisons", "scores", "usage", "trace", "final", "winner", "status"];
  return records.flatMap((record) =>
    resources.map((resource) => ({
      uri: `deepthonk://runs/${record.run_id}/${resource}`,
      name: `${record.run_id}/${resource}`,
      title: `DeepThonk ${resource} for ${record.run_id}`,
      mimeType: resourceMimeType(resource)
    }))
  );
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
