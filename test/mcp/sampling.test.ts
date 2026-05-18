import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deepthonkRun, type McpSamplingContext } from "@deepthonk/mcp";
import type { CreateMessageRequestParamsBase, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

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
      seed: 3,
      run_dir: runDir
    }, context);

    expect(result.winner_id).toBeTruthy();
    expect(createMessage).toHaveBeenCalled();
    expect(createMessage.mock.calls[0]?.[0].modelPreferences?.hints).toEqual([{ name: "sampling" }, { name: "host-fast" }]);
    expect(createMessage.mock.calls[0]?.[0].modelPreferences?.speedPriority).toBe(0.7);
    const storedConfig = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as {
      concurrency: { generate: number; judge: number; mutate: number };
    };
    expect(storedConfig.concurrency).toEqual({ generate: 4, judge: 4, mutate: 4 });
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
