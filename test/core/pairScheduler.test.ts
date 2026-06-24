import { describe, expect, it } from "vitest";
import { createRng, makeKRegularPairs } from "@deepthonk/core";

function key(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

describe("makeKRegularPairs", () => {
  it("creates a deterministic k-regular schedule without duplicate self pairs", () => {
    const ids = ["A", "B", "C", "D"];
    const pairs = makeKRegularPairs(ids, 2, createRng(123));
    const again = makeKRegularPairs(ids, 2, createRng(123));
    expect(pairs).toEqual(again);
    expect(new Set(pairs.map((pair) => key(pair.a, pair.b))).size).toBe(pairs.length);
    expect(pairs.every((pair) => pair.a !== pair.b)).toBe(true);
    const degrees = new Map(ids.map((id) => [id, 0]));
    for (const pair of pairs) {
      degrees.set(pair.a, degrees.get(pair.a)! + 1);
      degrees.set(pair.b, degrees.get(pair.b)! + 1);
    }
    expect([...degrees.values()]).toEqual([2, 2, 2, 2]);
  });

  it("constructs the built-in paper final dense schedule", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `c${index}`);
    const pairs = makeKRegularPairs(ids, 10, createRng(566775345));
    expect(pairs).toHaveLength(100);
    expect(new Set(pairs.map((pair) => key(pair.a, pair.b))).size).toBe(pairs.length);
    expect(pairs.every((pair) => pair.a !== pair.b)).toBe(true);
    const degrees = new Map(ids.map((id) => [id, 0]));
    for (const pair of pairs) {
      degrees.set(pair.a, degrees.get(pair.a)! + 1);
      degrees.set(pair.b, degrees.get(pair.b)! + 1);
    }
    expect([...degrees.values()]).toEqual(Array.from({ length: 20 }, () => 10));
  });

  it("constructs odd-degree schedules for even populations", () => {
    const ids = ["A", "B", "C", "D", "E", "F"];
    const pairs = makeKRegularPairs(ids, 3, createRng(77));
    expect(pairs).toHaveLength(9);
    expect(new Set(pairs.map((pair) => key(pair.a, pair.b))).size).toBe(pairs.length);
    expect(pairs.every((pair) => pair.a !== pair.b)).toBe(true);
    const degrees = new Map(ids.map((id) => [id, 0]));
    for (const pair of pairs) {
      degrees.set(pair.a, degrees.get(pair.a)! + 1);
      degrees.set(pair.b, degrees.get(pair.b)! + 1);
    }
    expect([...degrees.values()]).toEqual([3, 3, 3, 3, 3, 3]);
  });

  it("throws for invalid k", () => {
    expect(() => makeKRegularPairs(["A", "B"], 2, createRng(1))).toThrow(/k .* less than n/);
  });

  it("throws for odd n*k", () => {
    expect(() => makeKRegularPairs(["A", "B", "C"], 1, createRng(1))).toThrow(/n \* k must be even/);
  });
});
