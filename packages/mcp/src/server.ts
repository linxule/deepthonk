import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  deepthonkExport,
  deepthonkMutate,
  deepthonkPlan,
  deepthonkPlanAsync,
  deepthonkRank,
  deepthonkResume,
  deepthonkRun,
  deepthonkStart,
  deepthonkStatus,
  deepthonkResult,
  deepthonkCancel,
  deepthonkLockInspect,
  deepthonkLockReclaim,
  deepthonkRepairBudget,
  deepthonkProfileDelete,
  deepthonkProfileList,
  deepthonkProfileSave,
  deepthonkProfileShow,
  exportArgsSchema,
  jobArgsSchema,
  lockInspectArgsSchema,
  lockInspectOutputSchema,
  lockReclaimArgsSchema,
  lockReclaimOutputSchema,
  repairBudgetArgsSchema,
  repairBudgetOutputSchema,
  mutateArgsSchema,
  planArgsSchema,
  rankArgsSchema,
  resumeArgsSchema,
  runArgsSchema,
  runOutputSchema,
  startOutputSchema,
  statusOutputSchema,
  resultOutputSchema,
  cancelOutputSchema,
  resumeOutputSchema,
  rankOutputSchema,
  mutateOutputSchema,
  profileDeleteOutputSchema,
  profileListArgsSchema,
  profileListOutputSchema,
  profileNameArgsSchema,
  profileSaveArgsSchema,
  profileSaveOutputSchema,
  profileShowOutputSchema,
  toolError,
  toolResult,
  type McpSamplingContext
} from "./tools.js";
import { jobResourceMimeType, jobResourceName, listRunResources, readJobResource, readRunResource, runResourceMimeType } from "./resources.js";
import { renderPrompt } from "./prompts.js";

const packageVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string };

const MAX_SAMPLING_RESPONSE_BYTES = 1_000_000;

export function createDeepThonkMcpServer(options: { transport?: "stdio" | "http" } = {}): McpServer {
  const server = new McpServer({
    name: "deepthonk",
    version: packageVersion.version
  });
  const samplingContext: McpSamplingContext = {
    getClientCapabilities: () => server.server.getClientCapabilities(),
    createMessage: async (params, requestOptions) => {
      const result = await server.server.createMessage({ ...params, maxTokens: Math.min(params.maxTokens, 4096) }, requestOptions);
      if (result.content.type === "text" && Buffer.byteLength(result.content.text, "utf8") > MAX_SAMPLING_RESPONSE_BYTES) {
        throw new Error(`MCP Sampling response exceeds the ${MAX_SAMPLING_RESPONSE_BYTES}-byte safety limit.`);
      }
      return result;
    },
    transport: options.transport ?? "stdio"
  };

  server.registerTool(
    "deepthonk.plan",
    {
      title: "Plan DeepThonk Budget",
      description: "Estimate model calls for a DeepThonk profile.",
      inputSchema: planArgsSchema.shape,
      outputSchema: z.object({}).passthrough().describe("Budget plan with total calls and sequential rounds.")
    },
    async (args) => safeTool(async () => toolResult(args.config_path || args.profile_name ? await deepthonkPlanAsync(args) : deepthonkPlan(args)))
  );

  server.registerTool(
    "deepthonk.start",
    {
      title: "Start DeepThonk Job",
      description: "Start DeepThonk in the background and persist status in the run directory.",
      inputSchema: runArgsSchema.shape,
      outputSchema: startOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkStart(args, samplingContext)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.status",
    {
      title: "DeepThonk Job Status",
      description: "Read persisted job/run status from a run directory.",
      inputSchema: jobArgsSchema.shape,
      outputSchema: statusOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkStatus(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.result",
    {
      title: "DeepThonk Job Result",
      description: "Return final summary/resource URIs when a background job is complete.",
      inputSchema: jobArgsSchema.shape,
      outputSchema: resultOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkResult(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.cancel",
    {
      title: "Cancel DeepThonk Job",
      description: "Request cancellation for a running job by writing cancel.json in the run directory.",
      inputSchema: jobArgsSchema.shape,
      outputSchema: cancelOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkCancel(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.lock_inspect",
    {
      title: "Inspect DeepThonk Run Lock",
      description: "Inspect run.lock and return its exact fingerprint without mutating it.",
      inputSchema: lockInspectArgsSchema.shape,
      outputSchema: lockInspectOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkLockInspect(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.lock_reclaim",
    {
      title: "Reclaim DeepThonk Run Lock",
      description: "Reclaim run.lock only when its current bytes match the inspected fingerprint exactly.",
      inputSchema: lockReclaimArgsSchema.shape,
      outputSchema: lockReclaimOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkLockReclaim(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.repair_budget",
    {
      title: "Repair Legacy Budget Config",
      description: "Replace only legacy [redacted] numeric budget fields with explicit original values.",
      inputSchema: repairBudgetArgsSchema.shape,
      outputSchema: repairBudgetOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkRepairBudget(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.run",
    {
      title: "Run DeepThonk",
      description: "Run DeepThonk through the shared core engine.",
      inputSchema: runArgsSchema.shape,
      outputSchema: runOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkRun(args, samplingContext)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.rank",
    {
      title: "Rank Candidates",
      description: "Rank supplied candidates with pairwise judging and Bradley-Terry aggregation.",
      inputSchema: rankArgsSchema.shape,
      outputSchema: rankOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkRank(args, samplingContext)))
  );

  server.registerTool(
    "deepthonk.mutate",
    {
      title: "Mutate Candidate",
      description: "Mutate one supplied candidate with critique.",
      inputSchema: mutateArgsSchema.shape,
      outputSchema: mutateOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkMutate(args, samplingContext)))
  );

  server.registerTool(
    "deepthonk.resume",
    {
      title: "Resume Run",
      description: "Detect resume state (default) or replay an interrupted run with continue: true.",
      inputSchema: resumeArgsSchema.shape,
      outputSchema: resumeOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkResume(args, samplingContext)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.export",
    {
      title: "Export Run",
      description: "Export a run summary or trace.",
      inputSchema: exportArgsSchema.shape,
      outputSchema: z.object({}).passthrough().describe("Exported run data in the requested format.")
    },
    async (args) => safeTool(async () => toolResult(await deepthonkExport(args)), args.run_dir)
  );

  server.registerResource(
    "deepthonk-runs",
    "deepthonk://runs",
    {
      title: "DeepThonk Runs",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: await readRunResource(uri.href) }]
    })
  );

  server.registerResource(
    "deepthonk-runs-page",
    new ResourceTemplate("deepthonk://runs/page/{cursor}", { list: undefined }),
    { title: "DeepThonk Runs Page", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readRunResource(uri.href) }] })
  );

  server.registerResource(
    "deepthonk-run-resource",
    new ResourceTemplate("deepthonk://runs/{run_id}/{resource}", {
      list: async () => ({ resources: await listRunResources() })
    }),
    {
      title: "DeepThonk Run Resource",
      mimeType: "text/plain"
    },
    async (uri) => {
      const resource = uri.pathname.replace(/^\/+/, "").split("/")[1] ?? "trace";
      const mimeType = runResourceMimeType(resource);
      return { contents: [{ uri: uri.href, mimeType, text: await readRunResource(uri.href) }] };
    }
  );

  server.registerResource(
    "deepthonk-run-population",
    new ResourceTemplate("deepthonk://runs/{run_id}/population/{generation}", {
      list: async () => ({ resources: [] })
    }),
    {
      title: "DeepThonk Run Population",
      mimeType: "application/json"
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readRunResource(uri.href) }] })
  );

  server.registerResource(
    "deepthonk-run-resource-page",
    new ResourceTemplate("deepthonk://runs/{run_id}/{resource}/page/{cursor}", { list: undefined }),
    {
      title: "DeepThonk Run Resource Page",
      mimeType: "application/json"
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readRunResource(uri.href) }] })
  );

  server.registerResource(
    "deepthonk-run-population-page",
    new ResourceTemplate("deepthonk://runs/{run_id}/population/{generation}/page/{cursor}", { list: undefined }),
    {
      title: "DeepThonk Run Population Page",
      mimeType: "application/json"
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readRunResource(uri.href) }] })
  );

  server.registerResource(
    "deepthonk-job-resource",
    new ResourceTemplate("deepthonk://jobs/{job_id}/{resource}", {
      list: async () => ({ resources: [] })
    }),
    {
      title: "DeepThonk Job Resource",
      mimeType: "application/json"
    },
    async (uri) => {
      const resource = jobResourceName(uri.href);
      return { contents: [{ uri: uri.href, mimeType: jobResourceMimeType(resource), text: await readJobResource(uri.href) }] };
    }
  );

  server.registerResource(
    "deepthonk-job-population",
    new ResourceTemplate("deepthonk://jobs/{job_id}/population/{generation}", {
      list: async () => ({ resources: [] })
    }),
    {
      title: "DeepThonk Job Population",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: await readJobResource(uri.href) }]
    })
  );

  server.registerResource(
    "deepthonk-job-resource-page",
    new ResourceTemplate("deepthonk://jobs/{job_id}/{resource}/page/{cursor}", { list: undefined }),
    { title: "DeepThonk Job Resource Page", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readJobResource(uri.href) }] })
  );

  server.registerResource(
    "deepthonk-job-population-page",
    new ResourceTemplate("deepthonk://jobs/{job_id}/population/{generation}/page/{cursor}", { list: undefined }),
    { title: "DeepThonk Job Population Page", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readJobResource(uri.href) }] })
  );

  registerPrompt(server, "deepthonk/generate", { task: z.string().min(1), rubric: z.string().optional() });
  registerPrompt(server, "deepthonk/compare", {
    task: z.string().min(1),
    rubric: z.string().optional(),
    candidateA: z.string().min(1),
    candidateB: z.string().min(1)
  });
  registerPrompt(server, "deepthonk/mutate", {
    task: z.string().min(1),
    rubric: z.string().optional(),
    candidate: z.string().min(1),
    critique: z.string().default("")
  });
  registerPrompt(server, "deepthonk/finalize", {
    task: z.string().min(1),
    rubric: z.string().optional(),
    candidate: z.string().min(1)
  });

  server.registerTool(
    "deepthonk.profile_list",
    {
      title: "List DeepThonk Profiles",
      description: "List saved named profiles.",
      inputSchema: profileListArgsSchema.shape,
      outputSchema: profileListOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkProfileList(args)))
  );

  server.registerTool(
    "deepthonk.profile_show",
    {
      title: "Show DeepThonk Profile",
      description: "Show a saved named profile; manually edited secret-shaped values are rejected on load.",
      inputSchema: profileNameArgsSchema.shape,
      outputSchema: profileShowOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkProfileShow(args)))
  );

  server.registerTool(
    "deepthonk.profile_save",
    {
      title: "Save DeepThonk Profile",
      description: "Save a reusable named profile bundle.",
      inputSchema: profileSaveArgsSchema.shape,
      outputSchema: profileSaveOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkProfileSave(args)))
  );

  server.registerTool(
    "deepthonk.profile_delete",
    {
      title: "Delete DeepThonk Profile",
      description: "Delete a saved named profile.",
      inputSchema: profileNameArgsSchema.shape,
      outputSchema: profileDeleteOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkProfileDelete(args)))
  );

  return server;
}

async function safeTool<T extends ReturnType<typeof toolResult> | ReturnType<typeof toolError>>(
  action: () => T | Promise<T>,
  runDir?: string
): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await action();
  } catch (error) {
    return toolError(error, runDir);
  }
}

export async function serveMcp(options: { transport: "stdio" | "http"; port?: number }): Promise<void> {
  if (options.transport === "http") {
    await serveHttp(options.port ?? 3333);
    return;
  }
  const server = createDeepThonkMcpServer();
  await server.connect(new StdioServerTransport());
}

interface HttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActive: number;
  inFlight: number;
}

export interface McpHttpServerOptions {
  port: number;
  sessionIdleMs?: number;
  maxSessions?: number;
  now?: () => number;
}

export function createMcpHttpServer(options: McpHttpServerOptions): HttpServer {
  const sessions = new Map<string, HttpSession>();
  const sessionIdleMs = options.sessionIdleMs ?? 30 * 60_000;
  const maxSessions = options.maxSessions ?? 64;
  const now = options.now ?? Date.now;
  let pendingSessions = 0;
  let evicting = false;

  const closeSession = async (sessionId: string, session: HttpSession): Promise<void> => {
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    try {
      await session.server.close();
    } catch (error) {
      process.stderr.write(`deepthonk: failed to close MCP HTTP session: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  const evictIdleSessions = async (): Promise<void> => {
    if (evicting) return;
    evicting = true;
    try {
      const cutoff = now() - sessionIdleMs;
      const stale = [...sessions.entries()].filter(([, session]) => session.inFlight === 0 && session.lastActive <= cutoff);
      await Promise.all(stale.map(([sessionId, session]) => closeSession(sessionId, session)));
    } finally {
      evicting = false;
    }
  };

  let httpServer: HttpServer;
  const allowedHosts = (): string[] => {
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    return [`127.0.0.1:${port}`, `localhost:${port}`];
  };

  const handleSessionRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    allowed: string[]
  ): Promise<void> => {
    const sessionId = singleHeader(req.headers["mcp-session-id"]);
    let session = sessionId ? sessions.get(sessionId) : undefined;
    let isNew = false;

    if (!sessionId && req.method !== "POST") {
      jsonRpcHttpError(res, 400, -32000, "Mcp-Session-Id header is required.");
      return;
    }
    if (sessionId && !session) {
      jsonRpcHttpError(res, 404, -32001, "Session not found.");
      return;
    }

    if (!session) {
      await evictIdleSessions();
      if (sessions.size + pendingSessions >= maxSessions) {
        jsonRpcHttpError(res, 503, -32002, "MCP session capacity reached; retry after an idle session expires.", true);
        return;
      }
      pendingSessions += 1;
      isNew = true;
      const server = createDeepThonkMcpServer({ transport: "http" });
      const created: HttpSession = {
        server,
        transport: undefined as unknown as StreamableHTTPServerTransport,
        lastActive: now(),
        inFlight: 0
      };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedId) => {
          created.lastActive = now();
          sessions.set(initializedId, created);
        },
        onsessionclosed: (closedId) => {
          if (sessions.get(closedId) === created) sessions.delete(closedId);
        },
        enableJsonResponse: true,
        // CVE-2025-66414 / GHSA-w48q-cv73-mx4w: keep SDK protection on in
        // addition to the exact Host/Origin checks applied before every request.
        enableDnsRebindingProtection: true,
        allowedHosts: allowed
      });
      created.transport = transport;
      session = created;
      try {
        await server.connect(transport);
      } catch (error) {
        pendingSessions -= 1;
        throw error;
      }
    }

    session.lastActive = now();
    session.inFlight += 1;
    try {
      await session.transport.handleRequest(req, res, body);
    } finally {
      session.inFlight -= 1;
      session.lastActive = now();
      if (isNew) {
        pendingSessions -= 1;
        if (!session.transport.sessionId) await session.server.close().catch(() => undefined);
      }
      if (req.method === "DELETE" && sessionId) await closeSession(sessionId, session);
    }
  };

  httpServer = createServer(async (req, res) => {
    const allowed = allowedHosts();
    if (!isAllowedMcpHttpHost(req.headers.host, allowed)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden Host header." }, id: null }));
      return;
    }
    if (requestPath(req.url) !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
      return;
    }
    if (req.method === "POST" && !isApplicationJsonContentType(req.headers["content-type"])) {
      res.writeHead(415, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Content-Type must be application/json." }, id: null }));
      return;
    }
    if (!isAllowedLoopbackOrigin(req.headers.origin)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden Origin header." }, id: null }));
      return;
    }
    if (!isAllowedSecFetchSite(req.headers["sec-fetch-site"])) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden cross-site request." }, id: null }));
      return;
    }

    try {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await handleSessionRequest(req, res, body, allowed);
    } catch (error) {
      if (!res.headersSent) {
        const parseError = error instanceof SyntaxError;
        const bodyTooLarge = error instanceof HttpBodyTooLargeError;
        res.writeHead(parseError ? 400 : bodyTooLarge ? 413 : 500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: parseError ? -32700 : bodyTooLarge ? -32003 : -32603, message: parseError ? "Parse error." : (error as Error).message },
            id: null
          })
        );
      }
    }
  });
  const evictionTimer = setInterval(() => void evictIdleSessions(), Math.min(sessionIdleMs, 60_000));
  evictionTimer.unref();
  httpServer.on("close", () => {
    clearInterval(evictionTimer);
    for (const [sessionId, session] of sessions) void closeSession(sessionId, session);
  });
  return httpServer;
}

async function serveHttp(port: number): Promise<void> {
  const httpServer = createMcpHttpServer({ port });
  httpServer.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  process.stderr.write(`DeepThonk MCP Streamable HTTP listening on http://127.0.0.1:${port}/mcp\n`);
  await new Promise<void>((resolve) => {
    httpServer.on("close", resolve);
  });
}

function requestPath(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcHttpError(res: ServerResponse, status: number, code: number, message: string, retryable = false): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(retryable ? { "retry-after": "1" } : {})
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message, data: { retryable } }, id: null }));
}

export function isAllowedMcpHttpHost(host: string | undefined, allowedHosts: string[]): boolean {
  return Boolean(host && allowedHosts.includes(host));
}

export function isApplicationJsonContentType(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export function isAllowedLoopbackOrigin(origin: string | string[] | undefined): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value) return true;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isAllowedSecFetchSite(secFetchSite: string | string[] | undefined): boolean {
  const value = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite;
  return value?.trim().toLowerCase() !== "cross-site";
}

function registerPrompt(server: McpServer, name: string, argsSchema: z.ZodRawShape): void {
  server.registerPrompt(
    name,
    {
      title: name,
      description: "DeepThonk prompt template.",
      argsSchema
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: renderPrompt(name, args as Record<string, string>)
          }
        }
      ]
    })
  );
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const maxBytes = 1_000_000;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpBodyTooLargeError("Request body too large.");
    chunks.push(new Uint8Array(buffer));
  }
  const text = Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8");
  return text.trim() ? JSON.parse(text) : undefined;
}

class HttpBodyTooLargeError extends Error {}
