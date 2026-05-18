export class DeepThonkError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly fix?: string;

  constructor(message: string, options: { code?: string; retryable?: boolean; fix?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? this.name;
    this.retryable = options.retryable ?? false;
    this.fix = options.fix;
  }
}

export class ConfigError extends DeepThonkError {}
export class ProviderError extends DeepThonkError {}
export class JsonParseError extends DeepThonkError {}
export class BudgetExceededError extends DeepThonkError {}
export class CancelledError extends DeepThonkError {}
export class TraceError extends DeepThonkError {}
export class McpToolError extends DeepThonkError {}
