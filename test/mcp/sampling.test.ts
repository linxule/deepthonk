import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpHttpServer, deepthonkMutate, deepthonkRank, deepthonkResume, deepthonkRun, deepthonkStart, type McpSamplingContext } from "@deepthonk/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CreateMessageRequestSchema, type CreateMessageRequestParamsBase, type CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

describe("MCP Sampling provider", () => {
  it("runs deepthonk.run when the MCP client advertises sampling", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-sampling-"));
    const createMessage = vi.fn(async (params: CreateMessageRequestParamsBase) => textResult(responseFor(params)));
    const context: McpSamplingContext = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage
    };

    const result = await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "sampling",
      n: 6,
      concurrency: { generate: 9, judge: 9, mutate: 9 },
      sampling_model_hints: ["host-fast"],
      sampling_speed_priority: 0.7,
      provider_max_concurrency: 2,
      seed: 3,
      run_dir: runDir
    }, context);

    expect(result.winner_id).toBeTruthy();
    expect(createMessage).toHaveBeenCalled();
    expect(createMessage.mock.calls[0]?.[0].modelPreferences?.hints).toEqual([{ name: "sampling" }, { name: "host-fast" }]);
    expect(createMessage.mock.calls[0]?.[0].modelPreferences?.speedPriority).toBe(0.7);
    const storedConfig = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as {
      concurrency: { generate: number; judge: number; mutate: number };
      providerMaxConcurrency?: number;
    };
    expect(storedConfig.concurrency).toEqual({ generate: 4, judge: 4, mutate: 4 });
    expect(storedConfig.providerMaxConcurrency).toBe(2);
    await expect(deepthonkResume({ run_dir: runDir, continue: true }, context)).rejects.toMatchObject({ code: "resume.already_complete" });
  });

  it("refuses to resume a sampling run when the MCP client lacks the capability", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-sampling-resume-"));
    const createMessage = vi.fn(async (params: CreateMessageRequestParamsBase) => textResult(responseFor(params)));
    const context: McpSamplingContext = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage
    };
    await deepthonkRun({
      task: "toy",
      profile: "quick",
      provider: "sampling",
      n: 6,
      seed: 4,
      run_dir: runDir
    }, context);

    // Now attempt to resume with a context that no longer advertises sampling.
    const noSamplingContext: McpSamplingContext = {
      getClientCapabilities: () => ({}),
      createMessage: vi.fn(async () => textResult("unused"))
    };
    await expect(
      deepthonkResume({ run_dir: runDir, continue: true }, noSamplingContext)
    ).rejects.toMatchObject({ code: "provider.sampling_capability_missing" });
  });

  it("fails before running when the MCP client lacks sampling capability", async () => {
    const createMessage = vi.fn(async () => textResult("unused"));
    const context: McpSamplingContext = {
      getClientCapabilities: () => ({}),
      createMessage
    };

    await expect(
      deepthonkRun({
        task: "toy",
        profile: "quick",
        provider: "sampling"
      }, context)
    ).rejects.toMatchObject({ code: "provider.sampling_capability_missing" });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("applies one-shot rank and mutate output token controls to Sampling", async () => {
    const createMessage = vi.fn(async (params: CreateMessageRequestParamsBase) => textResult(responseFor(params)));
    const context: McpSamplingContext = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage
    };
    await deepthonkRank({
      task: "toy",
      provider: "sampling",
      candidates: ["first", "second"],
      model_output_tokens: { judge: 321 },
      rank: { mode: "all-pairs", seed: 4, max_calls: 1 }
    }, context);
    expect(createMessage.mock.calls.at(-1)?.[0].maxTokens).toBe(321);

    await deepthonkMutate({
      task: "toy",
      provider: "sampling",
      candidate: "draft",
      critique: "improve it",
      model_output_tokens: { mutation: 654 }
    }, context);
    expect(createMessage.mock.calls.at(-1)?.[0].maxTokens).toBe(654);
  });

  it("uses config-file one-shot controls with inline precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-mcp-sampling-config-controls-"));
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, [
      "profile: quick",
      "provider: sampling",
      "model_output_tokens:",
      "  judge: 222",
      "  mutation: 333",
      "rank:",
      "  mode: all-pairs",
      "  max_calls: 1",
      "provider_max_concurrency: 2"
    ].join("\n"));
    const createMessage = vi.fn(async (params: CreateMessageRequestParamsBase) => textResult(responseFor(params)));
    const context: McpSamplingContext = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage
    };

    await deepthonkRank({ task: "toy", config_path: configPath, candidates: ["a", "b"] }, context);
    expect(createMessage.mock.calls.at(-1)?.[0].maxTokens).toBe(222);
    await deepthonkMutate({
      task: "toy",
      config_path: configPath,
      candidate: "draft",
      critique: "improve",
      model_output_tokens: { mutation: 444 }
    }, context);
    expect(createMessage.mock.calls.at(-1)?.[0].maxTokens).toBe(444);
  });

  it("rejects only HTTP background Sampling", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-http-background-sampling-"));
    const context: McpSamplingContext = {
      transport: "http",
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: vi.fn(async () => textResult("unused"))
    };
    await expect(deepthonkStart({
      task: "toy",
      profile: "quick",
      provider: "sampling",
      run_dir: runDir
    }, context)).rejects.toMatchObject({ code: "mcp.http_background_sampling_unsupported" });
  });

  it("runs blocking Sampling through the official Streamable HTTP SDK client", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-mcp-http-sampling-roundtrip-"));
    const httpServer = createMcpHttpServer({ port: 0, sessionIdleMs: 60_000, maxSessions: 2 });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const client = new Client(
      { name: "deepthonk-http-sampling-test", version: "1.0.0" },
      { capabilities: { sampling: {} } }
    );
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => textResult(responseFor(request.params)));
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({
        name: "deepthonk.run",
        arguments: {
          task: "toy",
          profile: "quick",
          provider: "sampling",
          n: 6,
          seed: 11,
          run_dir: runDir
        }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ run_dir: runDir });
      expect((result.structuredContent as { winner_id?: string }).winner_id).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

function responseFor(params: CreateMessageRequestParamsBase): string {
  const text = textMessage(params);
  if (text.includes("SOLUTION A:")) {
    return JSON.stringify({
      feedback_a: "A is stronger.",
      feedback_b: "B is weaker.",
      winner: "A"
    });
  }
  if (text.includes("CURRENT CANDIDATE:")) return "Mutated candidate answer.";
  return "Generated candidate answer.";
}

function textMessage(params: CreateMessageRequestParamsBase): string {
  const content = params.messages[0]?.content;
  if (!content || Array.isArray(content)) return "";
  return content.type === "text" ? content.text : "";
}

function textResult(text: string): CreateMessageResult {
  return {
    model: "host-model",
    role: "assistant",
    content: { type: "text", text }
  };
}
