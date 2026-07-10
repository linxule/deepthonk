import { describe, expect, it } from "vitest";
import { normalizeExternalConfig } from "@deepthonk/providers";

describe("external config normalization", () => {
  it("normalizes canonical snake_case and legacy camelCase aliases", () => {
    expect(
      normalizeExternalConfig({
        run_id: "caller-run_1",
        profile: "quick",
        provider: "fake",
        retry: { http_retries: 2, invalidJsonRetries: 1, request_timeout_ms: 5000 },
        budget: { max_calls: 50, maxInputTokens: 1000, max_output_tokens: 2000, max_usd: 1.5 },
        output: { include_raw_model_outputs: false, includePrompts: true },
        algorithm: { n: 4, k: 2, t: 1, m: 2, sample_temperature: 0.7 },
        metadata: { arbitrary: { nested: true } }
      })
    ).toMatchObject({
      runId: "caller-run_1",
      retry: { httpRetries: 2, invalidJsonRetries: 1, requestTimeoutMs: 5000 },
      budget: { maxCalls: 50, maxInputTokens: 1000, maxOutputTokens: 2000, maxUsd: 1.5 },
      output: { includeRawModelOutputs: false, includePrompts: true },
      algorithm: { sample_temperature: 0.7 },
      metadata: { arbitrary: { nested: true } }
    });
  });

  it("rejects unknown operational keys but allows arbitrary metadata", () => {
    expect(() => normalizeExternalConfig({ profile: "quick", budegt: { max_calls: 2 } })).toThrow(
      expect.objectContaining({ code: "config.unknown_key" })
    );
    expect(() => normalizeExternalConfig({ metadata: { budegt: { whatever: true } } })).not.toThrow();
  });

  it("rejects conflicting aliases", () => {
    expect(() => normalizeExternalConfig({ budget: { max_calls: 50, maxCalls: 60 } })).toThrow(
      expect.objectContaining({ code: "config.alias_conflict" })
    );
  });

  it("validates leaf types, enums, ranges, and price rows", () => {
    for (const value of [
      { provider: 123 },
      { profile: "slow" },
      { supports_json_mode: "false" },
      { retry: { http_retries: -1 } },
      { algorithm: { n: 1 } },
      { budget: { prices: [{ provider: "p", model: "m", output_usd_per_million: -1 }] } },
      { budget: { prices: [{ provider: "p", model: "m", long_context_threshold_tokens: 10 }] } }
    ]) {
      expect(() => normalizeExternalConfig(value)).toThrow(expect.objectContaining({ code: "config.invalid_value" }));
    }
  });

  it("normalizes v0.2 output, critique, rank, and provider-limit fields", () => {
    expect(
      normalizeExternalConfig({
        model_output_tokens: { generation: 3000, mutation: 3001, judge: 800, finalizer: 3002 },
        critique_limits: { aggregate_chars: 12000 },
        rank: { mode: "k-regular", k: 8, seed: 42, max_calls: 4000 },
        provider_max_concurrency: 16
      })
    ).toMatchObject({
      modelOutputTokens: { generation: 3000, mutation: 3001, judge: 800, finalizer: 3002 },
      critiqueLimits: { aggregateChars: 12000 },
      rank: { mode: "k-regular", k: 8, seed: 42, maxCalls: 4000 },
      providerMaxConcurrency: 16
    });
    expect(
      normalizeExternalConfig({
        modelOutputTokens: { judge: 900 },
        critiqueLimits: { aggregateChars: 10000 },
        rank: { mode: "all-pairs", maxCalls: 91 },
        providerMaxConcurrency: 7
      })
    ).toMatchObject({
      modelOutputTokens: { judge: 900 },
      critiqueLimits: { aggregateChars: 10000 },
      rank: { mode: "all-pairs", maxCalls: 91 },
      providerMaxConcurrency: 7
    });
  });

  it("rejects invalid v0.2 config values and alias conflicts", () => {
    for (const value of [
      { model_output_tokens: { judge: 0 } },
      { critique_limits: { aggregate_chars: 255 } },
      { rank: { mode: "dense" } },
      { rank: { mode: "k-regular", k: 0 } },
      { provider_max_concurrency: 0 }
    ]) {
      expect(() => normalizeExternalConfig(value)).toThrow(expect.objectContaining({ code: "config.invalid_value" }));
    }
    expect(() =>
      normalizeExternalConfig({ provider_max_concurrency: 8, providerMaxConcurrency: 4 })
    ).toThrow(expect.objectContaining({ code: "config.alias_conflict" }));
  });
});
