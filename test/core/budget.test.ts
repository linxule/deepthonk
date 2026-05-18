import { describe, expect, it } from "vitest";
import { BudgetTracker, builtInProfiles, planBudget, type RunConfig } from "@deepthonk/core";

describe("planBudget", () => {
  it("returns paper call counts", () => {
    const plan = planBudget("paper");
    expect(plan.calls).toBe(285);
    expect(plan.sequential_rounds).toBe(8);
    expect(plan.per_generation_judge_calls).toBe(40);
    expect(plan.per_generation_mutate_calls).toBe(15);
    expect(plan.final_judge_calls).toBe(100);
  });

  it("rejects odd n*k", () => {
    expect(() =>
      planBudget({
        n: 3,
        k: 1,
        t: 1,
        m: 2,
        lambda: 0.01,
        sampleTemperature: 0.8,
        mutateTemperature: 0.6,
        judgeTemperature: 0
      })
    ).toThrow(/n\*k/);
  });

  it("does not plan paid mutations that are later dropped for non-divisible quartiles", () => {
    const plan = planBudget({
      n: 6,
      k: 3,
      t: 1,
      m: 3,
      lambda: 0.01,
      sampleTemperature: 1,
      mutateTemperature: 1,
      judgeTemperature: 0
    });
    expect(plan.per_generation_mutate_calls).toBe(4);
    expect(plan.calls).toBe(28);
  });

  it("estimates USD with cache hit and cache miss input prices", () => {
    const config: RunConfig = {
      task: "toy",
      profile: builtInProfiles.quick,
      runDir: "runs/test",
      seed: 1,
      provider: "deepseek",
      generatorModel: "deepseek-v4-flash",
      mutatorModel: "deepseek-v4-flash",
      judgeModel: "deepseek-v4-pro",
      concurrency: { generate: 1, judge: 1, mutate: 1 },
      retry: { httpRetries: 0, invalidJsonRetries: 0 },
      budget: {
        prices: [
          {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            inputCacheHitUsdPerMillion: 0.0028,
            inputCacheMissUsdPerMillion: 0.14,
            outputUsdPerMillion: 0.28
          }
        ]
      },
      output: { includeRawModelOutputs: false, includePrompts: false }
    };
    const tracker = new BudgetTracker(config);
    tracker.record({
      text: "x",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: { inputTokens: 100, inputCacheHitTokens: 40, inputCacheMissTokens: 60, outputTokens: 10, totalTokens: 110 }
    });

    expect(tracker.usage.usd).toBeCloseTo((40 * 0.0028 + 60 * 0.14 + 10 * 0.28) / 1_000_000);
  });
});
