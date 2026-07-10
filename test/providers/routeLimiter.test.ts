import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdaptiveRouteLimiter,
  createDriver,
  getSharedRouteLimiter,
  providerRouteLimiterKey,
  resetSharedRouteLimiters,
  resolveProviderConfig
} from "@deepthonk/providers";

describe("adaptive provider route limiter", () => {
  afterEach(() => {
    resetSharedRouteLimiters();
    vi.restoreAllMocks();
    delete process.env.ROUTE_SECRET_A;
    delete process.env.ROUTE_SECRET_B;
    delete process.env.ROUTE_SECRET_OTHER;
  });

  it("enforces a FIFO ceiling and removes aborted waiters", async () => {
    const limiter = new AdaptiveRouteLimiter("test", 2, 4);
    const first = await limiter.acquire();
    const second = await limiter.acquire();
    const order: string[] = [];
    const controller = new AbortController();
    const aborted = limiter.acquire(controller.signal);
    const queued = limiter.acquire().then((release) => {
      order.push("queued");
      return release;
    });

    expect(limiter.snapshot()).toMatchObject({ active: 2, queued: 2, ceiling: 2 });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter.snapshot().queued).toBe(1);
    first();
    const third = await queued;
    expect(order).toEqual(["queued"]);
    second();
    third();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("halves on rate limits and recovers one slot after 32 successes", () => {
    const limiter = new AdaptiveRouteLimiter("adaptive", 8, 12);
    limiter.recordRateLimit();
    expect(limiter.snapshot().ceiling).toBe(4);
    for (let index = 0; index < 31; index += 1) limiter.recordSuccess();
    expect(limiter.snapshot()).toMatchObject({ ceiling: 4, successesTowardIncrease: 31 });
    limiter.recordSuccess();
    expect(limiter.snapshot()).toMatchObject({ ceiling: 5, successesTowardIncrease: 0 });
  });

  it("shares normalized routes without keying on credential values", () => {
    const firstConfig = resolveProviderConfig({
      provider: "openai-compatible",
      baseUrl: "https://EXAMPLE.test/v1/",
      apiKeyEnv: "ROUTE_KEY",
      models: { generator: "g", mutator: "m", judge: "j" },
      providerMaxConcurrency: 16
    });
    const secondConfig = resolveProviderConfig({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "ROUTE_KEY",
      models: { generator: "other", mutator: "other", judge: "other" },
      providerMaxConcurrency: 16
    });
    expect(getSharedRouteLimiter(firstConfig)).toBe(getSharedRouteLimiter(secondConfig));
    expect(getSharedRouteLimiter(firstConfig).snapshot()).toMatchObject({ ceiling: 8, configuredMax: 16 });
    const sampling = resolveProviderConfig({ provider: "sampling", providerMaxConcurrency: 8 });
    expect(getSharedRouteLimiter(sampling).snapshot()).toMatchObject({ ceiling: 4, configuredMax: 8 });
    expect(providerRouteLimiterKey({ ...firstConfig, apiKey: "never-include-this" })).not.toContain("never-include-this");
    expect(
      getSharedRouteLimiter({ ...secondConfig, apiKeyEnv: "OTHER_ROUTE_KEY" })
    ).not.toBe(getSharedRouteLimiter(firstConfig));
  });

  it("keys credentials by a salted digest of the actual secret", () => {
    process.env.ROUTE_SECRET_A = "same-secret-value";
    process.env.ROUTE_SECRET_B = "same-secret-value";
    process.env.ROUTE_SECRET_OTHER = "different-secret-value";
    const route = {
      provider: "openai-compatible" as const,
      baseUrl: "https://credential.example/v1"
    };
    const fromFirstEnv = providerRouteLimiterKey({ ...route, apiKeyEnv: "ROUTE_SECRET_A" });
    const fromSecondEnv = providerRouteLimiterKey({ ...route, apiKeyEnv: "ROUTE_SECRET_B" });
    const fromInline = providerRouteLimiterKey({ ...route, apiKey: "same-secret-value" });
    const fromOtherEnv = providerRouteLimiterKey({ ...route, apiKeyEnv: "ROUTE_SECRET_OTHER" });
    const fromOtherInline = providerRouteLimiterKey({ ...route, apiKey: "another-secret-value" });

    expect(fromFirstEnv).toBe(fromSecondEnv);
    expect(fromFirstEnv).toBe(fromInline);
    expect(fromOtherEnv).not.toBe(fromFirstEnv);
    expect(fromOtherInline).not.toBe(fromInline);
    for (const secret of ["same-secret-value", "different-secret-value", "another-secret-value", "ROUTE_SECRET_A"]) {
      expect([fromFirstEnv, fromOtherEnv, fromOtherInline].join("\n")).not.toContain(secret);
    }
  });

  it("lets explicit direct and Sampling maxima raise default recovery ceilings", () => {
    const directDefault = resolveProviderConfig({
      provider: "openai-compatible",
      baseUrl: "https://late-limit.example/v1",
      apiKeyEnv: "LATE_LIMIT_KEY"
    });
    const directLimiter = getSharedRouteLimiter(directDefault);
    expect(directLimiter.snapshot()).toMatchObject({
      ceiling: 8,
      configuredMax: 8,
      explicitMaxConfigured: false
    });
    expect(
      getSharedRouteLimiter({ ...directDefault, providerMaxConcurrency: 16 })
    ).toBe(directLimiter);
    expect(directLimiter.snapshot()).toMatchObject({
      ceiling: 8,
      configuredMax: 16,
      explicitMaxConfigured: true
    });
    for (let index = 0; index < 32; index += 1) directLimiter.recordSuccess();
    expect(directLimiter.snapshot().ceiling).toBe(9);

    const samplingDefault = resolveProviderConfig({ provider: "sampling" });
    const samplingLimiter = getSharedRouteLimiter(samplingDefault);
    expect(samplingLimiter.snapshot()).toMatchObject({
      ceiling: 4,
      configuredMax: 4,
      explicitMaxConfigured: false
    });
    getSharedRouteLimiter({ ...samplingDefault, providerMaxConcurrency: 7 });
    for (let index = 0; index < 32; index += 1) samplingLimiter.recordSuccess();
    expect(samplingLimiter.snapshot()).toMatchObject({
      ceiling: 5,
      configuredMax: 7,
      explicitMaxConfigured: true
    });
  });

  it("uses the conservative minimum for conflicting explicit route maxima", () => {
    const config = resolveProviderConfig({
      provider: "openai-compatible",
      baseUrl: "https://conflict.example/v1",
      apiKeyEnv: "CONFLICT_KEY",
      providerMaxConcurrency: 16
    });
    const limiter = getSharedRouteLimiter(config);
    getSharedRouteLimiter({ ...config, providerMaxConcurrency: 12 });
    getSharedRouteLimiter({ ...config, providerMaxConcurrency: 20 });
    expect(limiter.snapshot()).toMatchObject({
      ceiling: 8,
      configuredMax: 12,
      explicitMaxConfigured: true
    });
  });

  it("shares the configured cap across matching base and role routes", async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
        return new Response(
          JSON.stringify({ choices: [{ message: { content: body.response_format ? '{"winner":"A"}' : "answer" } }] }),
          { status: 200 }
        );
      })
    );
    const driver = createDriver({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      models: { generator: "g", mutator: "m", judge: "j" },
      providerMaxConcurrency: 1,
      roleProviders: {
        judge: {
          provider: "openai-compatible",
          baseUrl: "https://example.test/v1/",
          apiKey: "secret",
          model: "j",
          providerMaxConcurrency: 1
        }
      }
    });
    await Promise.all([
      driver.generate({ task: "x", model: "g", temperature: 0, prompt: { system: "", user: "g" } }),
      driver.compare({
        task: "x",
        model: "j",
        temperature: 0,
        candidateA: candidate("a"),
        candidateB: candidate("b"),
        prompt: { system: "", user: "j" }
      })
    ]);
    expect(peak).toBe(1);
  });

  it("adapts the shared direct route after HTTP 429 and successful logical calls", async () => {
    const config = resolveProviderConfig({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      models: { generator: "g", mutator: "m", judge: "j" },
      providerMaxConcurrency: 8,
      retry: { httpRetries: 0 }
    });
    const driver = createDriver(config);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(driver.generate({ task: "x", model: "g", temperature: 0, prompt: { system: "", user: "u" } })).rejects.toMatchObject({
      code: "provider.http_429"
    });
    const limiter = getSharedRouteLimiter(config);
    expect(limiter.snapshot().ceiling).toBe(4);
    for (let index = 0; index < 32; index += 1) {
      await driver.generate({ task: "x", model: "g", temperature: 0, prompt: { system: "", user: "u" } });
    }
    expect(limiter.snapshot().ceiling).toBe(5);
  });
});

function candidate(id: string) {
  return { id, generation: 0, kind: "user-supplied" as const, content: id, metadata: { createdAt: "now" } };
}
