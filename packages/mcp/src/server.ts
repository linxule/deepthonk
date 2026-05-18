import { createServer } from "node:http";
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
  exportArgsSchema,
  jobArgsSchema,
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
  toolError,
  toolResult
} from "./tools.js";
import { listRunResources, readJobResource, readRunResource, runResourceMimeType } from "./resources.js";
import { renderPrompt } from "./prompts.js";

export function createDeepThonkMcpServer(): McpServer {
  const server = new McpServer({
    name: "deepthonk",
    version: "0.1.1"
  });

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
    async (args) => safeTool(async () => toolResult(await deepthonkStart(args)), args.run_dir)
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
    "deepthonk.run",
    {
      title: "Run DeepThonk",
      description: "Run DeepThonk through the shared core engine.",
      inputSchema: runArgsSchema.shape,
      outputSchema: runOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkRun(args)), args.run_dir)
  );

  server.registerTool(
    "deepthonk.rank",
    {
      title: "Rank Candidates",
      description: "Rank supplied candidates with pairwise judging and Bradley-Terry aggregation.",
      inputSchema: rankArgsSchema.shape,
      outputSchema: rankOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkRank(args)))
  );

  server.registerTool(
    "deepthonk.mutate",
    {
      title: "Mutate Candidate",
      description: "Mutate one supplied candidate with critique.",
      inputSchema: mutateArgsSchema.shape,
      outputSchema: mutateOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkMutate(args)))
  );

  server.registerTool(
    "deepthonk.resume",
    {
      title: "Resume Run",
      description: "Detect whether a run can be resumed.",
      inputSchema: resumeArgsSchema.shape,
      outputSchema: resumeOutputSchema.shape
    },
    async (args) => safeTool(async () => toolResult(await deepthonkResume(args)), args.run_dir)
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
    "deepthonk-job-resource",
    new ResourceTemplate("deepthonk://jobs/{job_id}/{resource}", {
      list: async () => ({ resources: [] })
    }),
    {
      title: "DeepThonk Job Resource",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: await readJobResource(uri.href) }]
    })
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

async function serveHttp(port: number): Promise<void> {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const httpServer = createServer(async (req, res) => {
    if (!isAllowedMcpHttpHost(req.headers.host, allowedHosts)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden Host header." }, id: null }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
      return;
    }

    try {
      const body = await readJsonBody(req);
      const server = createDeepThonkMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // CVE-2025-66414 / GHSA-w48q-cv73-mx4w: SDK ships with protection OFF.
        // Loopback bind blocks remote attackers; DNS rebinding still bypasses it via the browser.
        enableDnsRebindingProtection: true,
        allowedHosts
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        const parseError = error instanceof SyntaxError;
        res.writeHead(parseError ? 400 : 500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: parseError ? -32700 : -32603, message: parseError ? "Parse error." : (error as Error).message },
            id: null
          })
        );
      }
    }
  });
  httpServer.listen(port, "127.0.0.1");
  process.stderr.write(`DeepThonk MCP Streamable HTTP listening on http://127.0.0.1:${port}/mcp\n`);
  await new Promise<void>((resolve) => {
    httpServer.on("close", resolve);
  });
}

export function isAllowedMcpHttpHost(host: string | undefined, allowedHosts: string[]): boolean {
  return Boolean(host && allowedHosts.includes(host));
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
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(new Uint8Array(buffer));
  }
  const text = Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8");
  return text.trim() ? JSON.parse(text) : undefined;
}
