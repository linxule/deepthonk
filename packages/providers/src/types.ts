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

export interface ProviderConfig {
  provider: "fake" | "openai-compatible" | "deepseek" | string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
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
