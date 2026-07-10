import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { ConfigError, ProviderError } from "@deepthonk/core";
import { SamplingDriver, buildModelPreferences, createDriver, resetSharedRouteLimiters } from "@deepthonk/providers";
import type { CreateMessageRequestParamsBase, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

describe("SamplingDriver", () => {
  afterEach(() => {
    resetSharedRouteLimiters();
    vi.restoreAllMocks();
  });
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
    expect(createMessage.mock.calls.map(([params]) => params.maxTokens)).toEqual([4096, 1024, 4096, 4096]);
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

  it("honors per-call maxOutputTokens from the core driver contract", async () => {
    const createMessage = vi.fn(async () => textResult("answer"));
    const driver = new SamplingDriver(createMessage);
    await driver.generate({
      task: "task",
      model: "m",
      temperature: 0,
      maxOutputTokens: 777,
      prompt: { system: "", user: "u" }
    });
    expect(createMessage.mock.calls[0]?.[0].maxTokens).toBe(777);
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

  it("wraps createMessage rejection in non-retryable ProviderError", async () => {
    const createMessage = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    const driver = new SamplingDriver(createMessage);
    await expect(driver.generate({ task: "task", model: "m", temperature: 0, prompt: { system: "", user: "u" } })).rejects.toMatchObject({
      code: "provider.sampling_request_failed",
      retryable: false
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

  it("throws a non-retryable timeout ProviderError when the host stalls past requestTimeoutMs", async () => {
    const createMessage = vi.fn(() => new Promise<never>(() => {}));
    const driver = new SamplingDriver(createMessage, { requestTimeoutMs: 60 });
    const start = Date.now();
    await expect(
      driver.generate({ task: "task", model: "m", temperature: 0, prompt: { system: "", user: "u" } })
    ).rejects.toMatchObject({
      code: "provider.sampling_timeout",
      retryable: false
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("includes route-limiter queue wait in the Sampling request deadline", async () => {
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<CreateMessageResult>((resolve) => {
      unblockFirst = () => resolve(textResult("first"));
    });
    const firstTransport = vi.fn(() => firstBlocked);
    const waitingTransport = vi.fn(async () => textResult("second"));
    const firstDriver = new SamplingDriver(firstTransport, { requestTimeoutMs: 500, providerMaxConcurrency: 1 });
    const waitingDriver = new SamplingDriver(waitingTransport, { requestTimeoutMs: 30, providerMaxConcurrency: 1 });

    const first = firstDriver.generate({ task: "t", model: "m", temperature: 0, prompt: { system: "", user: "first" } });
    await vi.waitFor(() => expect(firstTransport).toHaveBeenCalledTimes(1));
    await expect(
      waitingDriver.generate({ task: "t", model: "m", temperature: 0, prompt: { system: "", user: "second" } })
    ).rejects.toMatchObject({ code: "provider.sampling_timeout" });
    expect(waitingTransport).not.toHaveBeenCalled();
    unblockFirst();
    await expect(first).resolves.toMatchObject({ text: "first" });
  });

  it("passes only the remaining logical deadline to createMessage after queueing", async () => {
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<CreateMessageResult>((resolve) => {
      unblockFirst = () => resolve(textResult("first"));
    });
    const firstDriver = new SamplingDriver(() => firstBlocked, { requestTimeoutMs: 500, providerMaxConcurrency: 1 });
    let observedTimeout: number | undefined;
    const secondDriver = new SamplingDriver(
      async (_params, options) => {
        observedTimeout = options?.timeout;
        return textResult("second");
      },
      { requestTimeoutMs: 200, providerMaxConcurrency: 1 }
    );

    const first = firstDriver.generate({ task: "t", model: "m", temperature: 0, prompt: { system: "", user: "first" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const second = secondDriver.generate({ task: "t", model: "m", temperature: 0, prompt: { system: "", user: "second" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    unblockFirst();
    await expect(first).resolves.toMatchObject({ text: "first" });
    await expect(second).resolves.toMatchObject({ text: "second" });
    expect(observedTimeout).toBeGreaterThan(0);
    expect(observedTimeout).toBeLessThan(190);
  });

  it("rejects oversized host responses before returning model text", async () => {
    const enormous = "a".repeat(1024 * 1024 + 1) + '{"winner":"A","feedback_a":"x","feedback_b":"y"}';
    const driver = new SamplingDriver(async () => textResult(enormous));
    let error: unknown;
    try {
      await driver.compare({ task: "t", model: "m", temperature: 0, prompt: { system: "", user: "u" }, candidateA: { id: "a", content: "" }, candidateB: { id: "b", content: "" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "provider.response_too_large" });
    const { extractJsonObjectText } = await import("@deepthonk/providers");
    expect(() => extractJsonObjectText(enormous)).toThrow(/exceeds .* JSON extraction cap/);
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

  it("removes run abort listeners after successful sampling calls", async () => {
    const controller = new AbortController();
    const driver = new SamplingDriver(async () => textResult("ok"));
    for (let index = 0; index < 20; index += 1) {
      await driver.generate({
        task: "t",
        model: "m",
        temperature: 0,
        prompt: { system: "s", user: "u" },
        signal: controller.signal
      });
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
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
