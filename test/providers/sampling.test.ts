import { describe, expect, it, vi } from "vitest";
import { ConfigError, ProviderError } from "@deepthonk/core";
import { SamplingDriver, buildModelPreferences, createDriver } from "@deepthonk/providers";
import type { CreateMessageRequestParamsBase, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

describe("SamplingDriver", () => {
  it("calls createMessage for generate, compare, mutate, and finalize with prompt messages and temperature", async () => {
    const createMessage = vi.fn(async () => textResult("answer"));
    const driver = new SamplingDriver(createMessage);
    const candidateA = candidate("a", "A");
    const candidateB = candidate("b", "B");

    await driver.generate({ task: "task", model: "generate-model", temperature: 0.7, prompt: { system: "system-g", user: "user-g" } });
    await driver.compare({
      task: "task",
      model: "judge-model",
      temperature: 0.1,
      candidateA,
      candidateB,
      prompt: { system: "system-c", user: "user-c" }
    });
    await driver.mutate({
      task: "task",
      model: "mutate-model",
      temperature: 0.9,
      candidate: candidateA,
      critique: "critique",
      prompt: { system: "system-m", user: "user-m" }
    });
    await driver.finalize?.({
      task: "task",
      model: "final-model",
      candidate: candidateA,
      prompt: { system: "system-f", user: "user-f" }
    });

    expect(createMessage).toHaveBeenCalledTimes(4);
    expect(createMessage.mock.calls.map(([params]) => params.temperature)).toEqual([0.7, 0.1, 0.9, 0.2]);
    expect(createMessage.mock.calls.map(([params]) => params.systemPrompt)).toEqual(["system-g", "system-c", "system-m", "system-f"]);
    expect(createMessage.mock.calls.map(([params]) => textMessage(params))).toEqual(["user-g", "user-c", "user-m", "user-f"]);
    expect(createMessage.mock.calls[0]?.[0].modelPreferences?.hints).toEqual([{ name: "generate-model" }]);
  });

  it("builds model preferences from role models, configured hints, and priorities", () => {
    expect(
      buildModelPreferences("judge-model", {
        modelHints: ["host-fast", "judge-model"],
        costPriority: 0.2,
        speedPriority: 0.8,
        intelligencePriority: 0.6
      })
    ).toEqual({
      hints: [{ name: "judge-model" }, { name: "host-fast" }],
      costPriority: 0.2,
      speedPriority: 0.8,
      intelligencePriority: 0.6
    });
    expect(buildModelPreferences(undefined, {})).toBeUndefined();
  });

  it("normalizes noisy comparison JSON before returning text", async () => {
    const createMessage = vi.fn(async () => textResult('prefix\n```json\n{"winner":"A","feedback_a":"ok","feedback_b":"no"}\n```\nsuffix'));
    const driver = new SamplingDriver(createMessage);
    const result = await driver.compare({
      task: "task",
      model: "judge-model",
      temperature: 0,
      candidateA: candidate("a", "A"),
      candidateB: candidate("b", "B"),
      prompt: { system: "", user: "judge" }
    });
    expect(result.text).toBe('{"winner":"A","feedback_a":"ok","feedback_b":"no"}');
  });

  it("wraps createMessage rejection in retryable ProviderError", async () => {
    const createMessage = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    const driver = new SamplingDriver(createMessage);
    await expect(driver.generate({ task: "task", model: "m", temperature: 0, prompt: { system: "", user: "u" } })).rejects.toMatchObject({
      code: "provider.sampling_request_failed",
      retryable: true
    });
    await expect(driver.generate({ task: "task", model: "m", temperature: 0, prompt: { system: "", user: "u" } })).rejects.toBeInstanceOf(ProviderError);
  });

  it("gates raw CreateMessageResult storage behind includeRawOutputs", async () => {
    const raw = textResult("answer", "host-model");
    const hidden = await new SamplingDriver(async () => raw).generate({ task: "task", model: "m", temperature: 0, prompt: { system: "", user: "u" } });
    const included = await new SamplingDriver(async () => raw, { includeRawOutputs: true }).generate({
      task: "task",
      model: "m",
      temperature: 0,
      prompt: { system: "", user: "u" }
    });
    expect(hidden.raw).toBeUndefined();
    expect(included.raw).toBe(raw);
    expect(included.usage).toEqual({ inputTokens: undefined, outputTokens: undefined });
  });

  it("requires an MCP sampling transport when created through the registry", () => {
    expect(() =>
      createDriver({
        provider: "sampling",
        models: { generator: "sampling", mutator: "sampling", judge: "sampling" }
      })
    ).toThrow(expect.objectContaining({ code: "provider.sampling_requires_mcp" }));
    expect(() =>
      createDriver({
        provider: "sampling",
        models: { generator: "sampling", mutator: "sampling", judge: "sampling" }
      })
    ).toThrow(ConfigError);
  });
});

function textResult(text: string, model = "host-model"): CreateMessageResult {
  return {
    model,
    role: "assistant",
    content: { type: "text", text }
  };
}

function textMessage(params: CreateMessageRequestParamsBase): string | undefined {
  const content = params.messages[0]?.content;
  if (!content || Array.isArray(content)) return undefined;
  return content.type === "text" ? content.text : undefined;
}

function candidate(id: string, content: string) {
  return {
    id,
    generation: 0,
    kind: "user-supplied" as const,
    content,
    metadata: { createdAt: "now" }
  };
}
