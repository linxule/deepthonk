import { createHmac, randomBytes } from "node:crypto";
import type { ProviderConfig } from "./types.js";

const DEFAULT_DIRECT_CONCURRENCY = 8;
const DEFAULT_SAMPLING_CONCURRENCY = 4;
const SUCCESSES_PER_INCREASE = 32;
const ROUTE_CREDENTIAL_SALT = randomBytes(32);

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface RouteLimiterSnapshot {
  key: string;
  active: number;
  queued: number;
  ceiling: number;
  configuredMax: number;
  explicitMaxConfigured: boolean;
  successesTowardIncrease: number;
}

/** FIFO adaptive concurrency limiter shared by every matching provider route in this process. */
export class AdaptiveRouteLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private ceilingValue: number;
  private configuredMaxValue: number;
  private explicitMaxConfiguredValue: boolean;
  private successesTowardIncrease = 0;

  constructor(readonly key: string, initialCeiling: number, configuredMax: number, explicitMaxConfigured = true) {
    this.configuredMaxValue = positiveInteger(configuredMax, "configuredMax");
    this.explicitMaxConfiguredValue = explicitMaxConfigured;
    this.ceilingValue = Math.min(positiveInteger(initialCeiling, "initialCeiling"), this.configuredMaxValue);
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.ceilingValue) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  recordRateLimit(): void {
    this.ceilingValue = Math.max(1, Math.floor(this.ceilingValue / 2));
    this.successesTowardIncrease = 0;
  }

  recordSuccess(): void {
    this.successesTowardIncrease += 1;
    if (this.successesTowardIncrease < SUCCESSES_PER_INCREASE) return;
    this.successesTowardIncrease = 0;
    if (this.ceilingValue < this.configuredMaxValue) {
      this.ceilingValue += 1;
      this.drain();
    }
  }

  /**
   * Unspecified defaults establish a starting point, not a permanent cap. Once a route
   * receives explicit maxima, conflicting explicit values resolve to their conservative minimum.
   */
  constrainConfiguredMax(configuredMax: number, explicitlyConfigured = true): void {
    if (!explicitlyConfigured) return;
    const validated = positiveInteger(configuredMax, "configuredMax");
    this.configuredMaxValue = this.explicitMaxConfiguredValue
      ? Math.min(this.configuredMaxValue, validated)
      : validated;
    this.explicitMaxConfiguredValue = true;
    this.ceilingValue = Math.min(this.ceilingValue, this.configuredMaxValue);
  }

  snapshot(): RouteLimiterSnapshot {
    return {
      key: this.key,
      active: this.active,
      queued: this.queue.length,
      ceiling: this.ceilingValue,
      configuredMax: this.configuredMaxValue,
      explicitMaxConfigured: this.explicitMaxConfiguredValue,
      successesTowardIncrease: this.successesTowardIncrease
    };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.ceilingValue && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.active += 1;
      waiter.resolve(this.releaseOnce());
    }
  }
}

const sharedLimiters = new Map<string, AdaptiveRouteLimiter>();

export function getSharedRouteLimiter(config: ProviderConfig): AdaptiveRouteLimiter {
  const key = providerRouteLimiterKey(config);
  const defaultCeiling = config.provider === "sampling" ? DEFAULT_SAMPLING_CONCURRENCY : DEFAULT_DIRECT_CONCURRENCY;
  const explicitMaxConfigured = config.providerMaxConcurrency !== undefined;
  const configuredMax = config.providerMaxConcurrency ?? defaultCeiling;
  const existing = sharedLimiters.get(key);
  if (existing) {
    existing.constrainConfiguredMax(configuredMax, explicitMaxConfigured);
    return existing;
  }
  const limiter = new AdaptiveRouteLimiter(key, defaultCeiling, configuredMax, explicitMaxConfigured);
  sharedLimiters.set(key, limiter);
  return limiter;
}

export function providerRouteLimiterKey(config: Pick<ProviderConfig, "provider" | "baseUrl" | "apiKeyEnv" | "apiKey">): string {
  const endpoint = normalizeEndpoint(config.baseUrl) ?? (config.provider === "sampling" ? "mcp:sampling" : "default");
  const credentialIdentity = routeCredentialIdentity(config);
  return `${config.provider}|${endpoint}|${credentialIdentity}`;
}

/** Test-only process registry reset. */
export function resetSharedRouteLimiters(): void {
  sharedLimiters.clear();
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function routeCredentialIdentity(config: Pick<ProviderConfig, "apiKeyEnv" | "apiKey">): string {
  const secret = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
  if (secret) return `secret:${saltedDigest(secret)}`;
  if (config.apiKeyEnv) return `missing-env:${saltedDigest(config.apiKeyEnv)}`;
  return "none";
}

function saltedDigest(value: string): string {
  return createHmac("sha256", ROUTE_CREDENTIAL_SALT).update(value).digest("hex");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function abortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException ? signal.reason : new DOMException("Aborted", "AbortError");
}
