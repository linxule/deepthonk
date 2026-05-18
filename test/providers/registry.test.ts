import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriver } from "@deepthonk/providers";

describe("provider registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats unknown providers with baseUrl as OpenAI-compatible aliases", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ model: "alias-model", choices: [{ message: { content: "answer" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = createDriver({
      provider: "my-provider",
      baseUrl: "https://provider.example.com/v1",
      apiKey: "secret",
      models: { generator: "alias-model", mutator: "alias-model", judge: "alias-model" }
    });

    const result = await driver.generate({ task: "x", model: "alias-model", temperature: 0, prompt: { system: "s", user: "u" } });

    expect(result.provider).toBe("my-provider");
    expect(fetchMock).toHaveBeenCalledWith("https://provider.example.com/v1/chat/completions", expect.any(Object));
  });

  it("routes role-specific providers and model names", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ model: "judge-model", choices: [{ message: { content: JSON.stringify({ winner: "A" }) } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = createDriver({
      provider: "fake",
      models: { generator: "fake-model", mutator: "fake-model", judge: "fake-model" },
      roleProviders: {
        judge: {
          provider: "judge-provider",
          baseUrl: "https://judge.example.com/v1",
          apiKey: "secret",
          model: "judge-model"
        }
      }
    });

    await driver.compare({
      task: "x",
      model: "ignored-base-model",
      temperature: 0,
      candidateA: { id: "a", generation: 0, kind: "user-supplied", content: "A", metadata: { createdAt: "now" } },
      candidateB: { id: "b", generation: 0, kind: "user-supplied", content: "B", metadata: { createdAt: "now" } },
      prompt: { system: "s", user: "u" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(fetchMock).toHaveBeenCalledWith("https://judge.example.com/v1/chat/completions", expect.any(Object));
    expect(body.model).toBe("judge-model");
  });

  it("returns structured errors for unknown providers without a base URL", () => {
    expect(() =>
      createDriver({
        provider: "unknown",
        models: { generator: "m", mutator: "m", judge: "m" }
      })
    ).toThrow(expect.objectContaining({ code: "provider.unknown_provider", retryable: false }));
  });
});
