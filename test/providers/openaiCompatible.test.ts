import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleDriver } from "@deepthonk/providers";

describe("OpenAiCompatibleDriver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEST_PROVIDER_KEY;
  });

  it("posts chat completions and maps usage", async () => {
    process.env.TEST_PROVIDER_KEY = "secret";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "m",
          choices: [{ message: { content: "answer" } }],
          usage: { prompt_tokens: 1, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 0, completion_tokens: 2, total_tokens: 3 }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = new OpenAiCompatibleDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      models: { generator: "m", mutator: "m", judge: "m" }
    });
    expect(driver.requestTimeoutMs).toBe(120_000);
    const result = await driver.generate({
      task: "x",
      model: "m",
      temperature: 0,
      prompt: { system: "s", user: "u" }
    });
    expect(result.text).toBe("answer");
    expect(result.usage?.totalTokens).toBe(3);
    expect(result.usage?.inputCacheHitTokens).toBe(1);
    expect(result.usage?.inputCacheMissTokens).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/v1/chat/completions", expect.any(Object));
  });

  it("reports retry count after retryable provider errors", async () => {
    process.env.TEST_PROVIDER_KEY = "secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "answer" } }] }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = new OpenAiCompatibleDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      models: { generator: "m", mutator: "m", judge: "m" },
      retry: { httpRetries: 1 }
    });
    const result = await driver.generate({
      task: "x",
      model: "m",
      temperature: 0,
      prompt: { system: "s", user: "u" }
    });
    expect(result.retryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sanitizes provider HTTP errors", async () => {
    process.env.TEST_PROVIDER_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret upstream body", { status: 400 })));
    const driver = new OpenAiCompatibleDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      models: { generator: "m", mutator: "m", judge: "m" },
      retry: { httpRetries: 0 }
    });
    await expect(
      driver.generate({
        task: "x",
        model: "m",
        temperature: 0,
        prompt: { system: "s", user: "u" }
      })
    ).rejects.toMatchObject({ code: "provider.http_400", message: "Provider HTTP 400 from openai-compatible." });
    await expect(
      driver.generate({
        task: "x",
        model: "m",
        temperature: 0,
        prompt: { system: "s", user: "u" }
      })
    ).rejects.not.toThrow(/secret upstream body/);
  });

  it("times out slow requests", async () => {
    process.env.TEST_PROVIDER_KEY = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
      )
    );
    const driver = new OpenAiCompatibleDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      models: { generator: "m", mutator: "m", judge: "m" },
      retry: { httpRetries: 0, requestTimeoutMs: 1 }
    });
    await expect(
      driver.generate({
        task: "x",
        model: "m",
        temperature: 0,
        prompt: { system: "s", user: "u" }
      })
    ).rejects.toMatchObject({ code: "provider.timeout", retryable: true });
  });

  it("rejects truncated provider outputs", async () => {
    process.env.TEST_PROVIDER_KEY = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ model: "m", choices: [{ finish_reason: "length", message: { content: "partial" } }] }), { status: 200 }))
    );
    const driver = new OpenAiCompatibleDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      models: { generator: "m", mutator: "m", judge: "m" },
      retry: { httpRetries: 0 }
    });
    await expect(
      driver.generate({
        task: "x",
        model: "m",
        temperature: 0,
        prompt: { system: "s", user: "u" }
      })
    ).rejects.toMatchObject({ code: "provider.output_truncated" });
  });

  it("caches JSON-mode fallback after provider rejection", async () => {
    process.env.TEST_PROVIDER_KEY = "secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("response_format is not supported", { status: 422 }))
      .mockImplementation(async () =>
        new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "{\"winner\":\"A\"}" } }] }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = new OpenAiCompatibleDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      models: { generator: "m", mutator: "m", judge: "m" },
      retry: { httpRetries: 0 }
    });
    await driver.compare({
      task: "x",
      model: "m",
      temperature: 0,
      candidateA: candidate("A"),
      candidateB: candidate("B"),
      prompt: { system: "s", user: "u" }
    });
    await driver.compare({
      task: "x",
      model: "m",
      temperature: 0,
      candidateA: candidate("A"),
      candidateB: candidate("B"),
      prompt: { system: "s", user: "u" }
    });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { response_format?: unknown });
    expect(bodies).toHaveLength(3);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].response_format).toBeUndefined();
    expect(bodies[2].response_format).toBeUndefined();
  });
});

function candidate(id: string) {
  return {
    id,
    generation: 0,
    kind: "user-supplied" as const,
    content: `candidate ${id}`,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z" }
  };
}
