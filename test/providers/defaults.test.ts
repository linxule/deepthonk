import { describe, expect, it } from "vitest";
import { defaultProviderPricing, resolveProviderConfig, resolveProviderModels } from "@deepthonk/providers";

describe("provider defaults", () => {
  it("centralizes DeepSeek model and credential defaults", () => {
    const config = resolveProviderConfig({ provider: "deepseek" });

    expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(config.models).toEqual({
      generator: "deepseek-v4-flash",
      mutator: "deepseek-v4-flash",
      judge: "deepseek-v4-pro",
      finalizer: undefined
    });
  });

  it("applies role-specific overrides without copying defaults in adapters", () => {
    expect(resolveProviderModels("openai-compatible", { judge: "strong-model" })).toMatchObject({
      generator: "provider/model-small",
      mutator: "provider/model-small",
      judge: "strong-model"
    });
  });

  it("includes OpenRouter defaults and role-provider overrides", () => {
    const config = resolveProviderConfig({
      provider: "openrouter",
      models: { generator: "meta/fast", mutator: "meta/fast", judge: "anthropic/strong" },
      roleProviders: {
        judge: { provider: "deepseek", model: "deepseek-v4-pro" }
      }
    });

    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(config.roleProviders?.judge).toMatchObject({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-v4-pro"
    });
  });

  it("lets role providers override base JSON-mode support", () => {
    const config = resolveProviderConfig({
      provider: "openai-compatible",
      supportsJsonMode: false,
      roleProviders: {
        generator: { provider: "openai-compatible", model: "fast-model" },
        judge: { provider: "openai-compatible", model: "judge-model", supportsJsonMode: true }
      }
    });

    expect(config.supportsJsonMode).toBe(false);
    expect(config.roleProviders?.generator?.supportsJsonMode).toBe(false);
    expect(config.roleProviders?.judge?.supportsJsonMode).toBe(true);
  });

  it("ships official DeepSeek V4 pricing defaults", () => {
    expect(defaultProviderPricing).toContainEqual(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        inputCacheHitUsdPerMillion: 0.0028,
        inputCacheMissUsdPerMillion: 0.14,
        outputUsdPerMillion: 0.28
      })
    );
    expect(defaultProviderPricing).toContainEqual(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        inputCacheHitUsdPerMillion: 0.003625,
        inputCacheMissUsdPerMillion: 0.435,
        outputUsdPerMillion: 0.87
      })
    );
  });
});
