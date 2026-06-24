import { ConfigError } from "@deepthonk/core";

const DECIMAL_NUMBER_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

export interface NumberOptionConstraints {
  integer?: boolean;
  min?: number;
  max?: number;
}

export function numberOption(value: unknown, flag: string, constraints: NumberOptionConstraints = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parseNumber(value, flag);
  if (
    !Number.isFinite(parsed) ||
    (constraints.integer && !Number.isInteger(parsed)) ||
    (constraints.min !== undefined && parsed < constraints.min) ||
    (constraints.max !== undefined && parsed > constraints.max)
  ) {
    throw invalidOption(flag, `${numberExpectation(constraints)}.`, value);
  }
  return parsed;
}

export function booleanOption(value: unknown, flag: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw invalidOption(flag, "true or false.", value);
}

export function stringOption(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function parseNumber(value: unknown, flag: string): number {
  if (typeof value === "number") return value;
  const text = String(value).trim();
  if (!DECIMAL_NUMBER_RE.test(text)) throw invalidOption(flag, "a decimal number.", value);
  return Number(text);
}

function numberExpectation(constraints: NumberOptionConstraints): string {
  const base = constraints.integer ? "an integer" : "a number";
  const ranges = [
    constraints.min !== undefined ? `>= ${constraints.min}` : undefined,
    constraints.max !== undefined ? `<= ${constraints.max}` : undefined
  ].filter(Boolean);
  return ranges.length ? `${base} ${ranges.join(" and ")}` : base;
}

function invalidOption(flag: string, expectation: string, value: unknown): ConfigError {
  return new ConfigError(`${flag} must be ${expectation} Received '${String(value)}'.`, {
    code: "config.invalid_cli_option",
    retryable: false,
    fix: `Pass ${flag} with ${expectation}`
  });
}
