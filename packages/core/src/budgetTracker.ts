import { BudgetExceededError, ConfigError } from "./errors.js";
import type { BudgetUsage, UsageDelta } from "./lifecycle.js";
import { emptyUsage } from "./lifecycle.js";
import type { ModelTextResult, RunConfig } from "./schemas.js";

type Price = NonNullable<NonNullable<RunConfig["budget"]>["prices"]>[number];

export class BudgetTracker {
  readonly usage: BudgetUsage = emptyUsage();
  private readonly prices: Price[];

  constructor(private readonly config: RunConfig) {
    this.prices = config.budget?.prices ?? [];
    if (config.budget?.maxUsd !== undefined && this.prices.length === 0) {
      throw new ConfigError("Cannot enforce maxUsd without budget.prices.", {
        code: "budget.price_missing",
        fix: "Add budget.prices entries with inputUsdPerMillion and outputUsdPerMillion, or remove maxUsd."
      });
    }
  }

  record(result: ModelTextResult, fallback: { provider?: string; model: string; calls?: number } = { model: "unknown" }): UsageDelta {
    const calls = fallback.calls ?? 1;
    this.usage.calls += calls;
    const inputCacheHitTokens = result.usage?.inputCacheHitTokens ?? 0;
    const inputCacheMissTokens = result.usage?.inputCacheMissTokens ?? 0;
    const inputTokens = result.usage?.inputTokens ?? inputCacheHitTokens + inputCacheMissTokens;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const totalTokens = result.usage?.totalTokens ?? inputTokens + outputTokens;
    this.usage.inputTokens += inputTokens;
    if (result.usage?.inputCacheHitTokens !== undefined) this.usage.inputCacheHitTokens = (this.usage.inputCacheHitTokens ?? 0) + inputCacheHitTokens;
    if (result.usage?.inputCacheMissTokens !== undefined) this.usage.inputCacheMissTokens = (this.usage.inputCacheMissTokens ?? 0) + inputCacheMissTokens;
    this.usage.outputTokens += outputTokens;
    this.usage.totalTokens += totalTokens;
    const provider = result.provider ?? fallback.provider ?? this.config.provider;
    const model = result.model ?? fallback.model;
    const price = this.findPrice(provider, model);
    let inputUsd: number | undefined;
    let outputUsd: number | undefined;
    if (price) {
      if (this.config.budget?.maxUsd !== undefined) this.requirePrice(provider, model);
      inputUsd = inputUsdForUsage(price, {
        inputTokens,
        inputCacheHitTokens: result.usage?.inputCacheHitTokens,
        inputCacheMissTokens: result.usage?.inputCacheMissTokens
      });
      outputUsd = (outputTokens / 1_000_000) * outputRateFor(price, inputTokens);
      this.usage.usd = (this.usage.usd ?? 0) + inputUsd + outputUsd;
    } else if (this.config.budget?.maxUsd !== undefined) {
      this.requirePrice(provider, model);
    }
    return {
      calls,
      inputTokens,
      inputCacheHitTokens: result.usage?.inputCacheHitTokens,
      inputCacheMissTokens: result.usage?.inputCacheMissTokens,
      outputTokens,
      totalTokens,
      inputUsd,
      outputUsd,
      usd: inputUsd !== undefined && outputUsd !== undefined ? inputUsd + outputUsd : undefined
    };
  }

  assertWithinBudget(phase: string): void {
    const budget = this.config.budget;
    if (!budget) return;
    if (budget.maxCalls !== undefined && this.usage.calls > budget.maxCalls) {
      throw new BudgetExceededError(`Budget exceeded after ${phase}: calls ${this.usage.calls} > maxCalls ${budget.maxCalls}.`, {
        code: "budget.calls_exceeded",
        fix: "Raise maxCalls or use a smaller profile."
      });
    }
    if (budget.maxInputTokens !== undefined && this.usage.inputTokens > budget.maxInputTokens) {
      throw new BudgetExceededError(`Budget exceeded after ${phase}: input tokens ${this.usage.inputTokens} > maxInputTokens ${budget.maxInputTokens}.`, {
        code: "budget.input_tokens_exceeded",
        fix: "Raise maxInputTokens, reduce concurrency, or use a smaller profile."
      });
    }
    if (budget.maxOutputTokens !== undefined && this.usage.outputTokens > budget.maxOutputTokens) {
      throw new BudgetExceededError(`Budget exceeded after ${phase}: output tokens ${this.usage.outputTokens} > maxOutputTokens ${budget.maxOutputTokens}.`, {
        code: "budget.output_tokens_exceeded",
        fix: "Raise maxOutputTokens, reduce concurrency, or use a smaller profile."
      });
    }
    if (budget.maxUsd !== undefined && (this.usage.usd ?? 0) > budget.maxUsd) {
      throw new BudgetExceededError(`Budget exceeded after ${phase}: estimated USD ${(this.usage.usd ?? 0).toFixed(6)} > maxUsd ${budget.maxUsd}.`, {
        code: "budget.usd_exceeded",
        fix: "Raise maxUsd, add cheaper models, or use a smaller profile."
      });
    }
  }

  private requirePrice(provider: string, model: string): Price {
    const price = this.findPrice(provider, model);
    if (!price || !hasUsableInputPrice(price) || price.outputUsdPerMillion === undefined) {
      throw new ConfigError(`Cannot enforce maxUsd without pricing for ${provider}/${model}.`, {
        code: "budget.price_missing",
        fix: "Add budget.prices entries with input/output prices, or remove maxUsd."
      });
    }
    return price;
  }

  private findPrice(provider: string, model: string): Price | undefined {
    return this.prices.find((entry) => entry.provider === provider && entry.model === model);
  }
}

function inputUsdForUsage(price: Price, usage: { inputTokens: number; inputCacheHitTokens?: number; inputCacheMissTokens?: number }): number {
  // Cache hit/miss rates are flat in v0.1 — long-context tier does not apply when the provider
  // reports prompt_cache_hit_tokens / prompt_cache_miss_tokens. Real pricing tables for tiered
  // models (Gemini, GPT-5.4) rarely tier their cache rates, and DeepSeek does not have long-context tiers today.
  if (usage.inputCacheHitTokens !== undefined && usage.inputCacheMissTokens !== undefined) {
    const hit = (usage.inputCacheHitTokens / 1_000_000) * (price.inputCacheHitUsdPerMillion ?? price.inputUsdPerMillion ?? 0);
    const miss = (usage.inputCacheMissTokens / 1_000_000) * (price.inputCacheMissUsdPerMillion ?? price.inputUsdPerMillion ?? 0);
    return hit + miss;
  }
  const rate = isLongContext(price, usage.inputTokens)
    ? (price.inputUsdPerMillionLong ?? price.inputUsdPerMillion ?? 0)
    : (price.inputUsdPerMillion ?? price.inputCacheMissUsdPerMillion ?? 0);
  return (usage.inputTokens / 1_000_000) * rate;
}

function outputRateFor(price: Price, inputTokens: number): number {
  return isLongContext(price, inputTokens)
    ? (price.outputUsdPerMillionLong ?? price.outputUsdPerMillion ?? 0)
    : (price.outputUsdPerMillion ?? 0);
}

function isLongContext(price: Price, inputTokens: number): boolean {
  if (price.longContextThresholdTokens === undefined) return false;
  if (price.inputUsdPerMillionLong === undefined && price.outputUsdPerMillionLong === undefined) return false;
  return inputTokens > price.longContextThresholdTokens;
}

function hasUsableInputPrice(price: Price): boolean {
  return (
    price.inputUsdPerMillion !== undefined ||
    price.inputCacheMissUsdPerMillion !== undefined ||
    price.inputCacheHitUsdPerMillion !== undefined
  );
}
