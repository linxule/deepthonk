import type { SamplingDriverConfig, SamplingTransport } from "./sampling.js";

export type {
  CompareInput,
  FinalizeInput,
  GenerateInput,
  ModelDriver,
  ModelTextResult,
  MutateInput
} from "@deepthonk/core";

export type ProviderRole = "generator" | "mutator" | "judge" | "finalizer";

export interface RoleProviderConfig {
  provider: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  model: string;
  retry?: {
    httpRetries?: number;
    requestTimeoutMs?: number;
  };
  supportsJsonMode?: boolean;
}

export interface BaseProviderConfig extends SamplingDriverConfig {
  provider: "fake" | "openai-compatible" | "deepseek" | string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  samplingTransport?: SamplingTransport;
  models: {
    generator: string;
    mutator: string;
    judge: string;
    finalizer?: string;
  };
  retry?: {
    httpRetries?: number;
    requestTimeoutMs?: number;
  };
  supportsJsonMode?: boolean;
  roleProviders?: Partial<Record<ProviderRole, RoleProviderConfig>>;
}

export type SamplingProviderConfig = BaseProviderConfig &
  SamplingDriverConfig & {
    provider: "sampling";
    samplingTransport?: SamplingTransport;
  };

export type ProviderConfig = BaseProviderConfig | SamplingProviderConfig;
