import type { ProviderConfig, ProviderRole } from "./types.js";

export interface ModelPrice {
  provider: string;
  model: string;
  inputUsdPerMillion?: number;
  inputCacheHitUsdPerMillion?: number;
  inputCacheMissUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  longContextThresholdTokens?: number;
  inputUsdPerMillionLong?: number;
  outputUsdPerMillionLong?: number;
  source?: string;
  note?: string;
}

export const defaultProviderPricing: ModelPrice[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    inputUsdPerMillion: 0.14,
    inputCacheHitUsdPerMillion: 0.0028,
    inputCacheMissUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    note: "Official DeepSeek pricing page, checked 2026-06-24. Input uses cache-hit/cache-miss fields when provider usage reports them."
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    inputUsdPerMillion: 0.435,
    inputCacheHitUsdPerMillion: 0.003625,
    inputCacheMissUsdPerMillion: 0.435,
    outputUsdPerMillion: 0.87,
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    note: "Official DeepSeek pricing page, checked 2026-06-24. Input uses cache-hit/cache-miss fields when provider usage reports them."
  }
];

export const editablePricing: ModelPrice[] = defaultProviderPricing;

export function defaultPricesForProviderConfig(config: ProviderConfig): ModelPrice[] {
  const keys = new Set<string>();
  const add = (provider: string, model: string | undefined) => {
    if (model) keys.add(`${provider}/${model}`);
  };
  for (const role of ["generator", "mutator", "judge", "finalizer"] as ProviderRole[]) {
    add(config.provider, config.models[role]);
    const route = config.roleProviders?.[role];
    if (route) add(route.provider, route.model);
  }
  return defaultProviderPricing.filter((price) => keys.has(`${price.provider}/${price.model}`));
}
