import { ConfigError } from "./errors.js";
import type { Rng } from "./rng.js";

export interface Pair {
  a: string;
  b: string;
}

export function makeKRegularPairs(candidateIds: string[], k: number, rng: Rng): Pair[] {
  const ids = rng.shuffle(candidateIds);
  const n = ids.length;
  if (n < 2) throw new ConfigError("Pair scheduling requires at least two candidates.");
  if (k >= n) throw new ConfigError(`Invalid pair schedule: k (${k}) must be less than n (${n}).`);
  if ((n * k) % 2 !== 0) {
    throw new ConfigError(`Invalid pair schedule: n * k must be even, got ${n} * ${k}.`);
  }

  const pairs: Pair[] = [];
  const halfDegree = Math.floor(k / 2);
  for (let offset = 1; offset <= halfDegree; offset += 1) {
    for (let i = 0; i < n; i += 1) {
      pairs.push({ a: ids[i], b: ids[(i + offset) % n] });
    }
  }

  if (k % 2 === 1) {
    const opposite = n / 2;
    for (let i = 0; i < opposite; i += 1) {
      pairs.push({ a: ids[i], b: ids[i + opposite] });
    }
  }

  if (!hasDegree(ids, pairs, k)) {
    throw new ConfigError(`Could not construct ${k}-regular pair schedule for ${ids.length} candidates.`);
  }
  return rng.shuffle(pairs);
}

function unorderedKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function hasDegree(ids: string[], pairs: Pair[], k: number): boolean {
  const degrees = new Map(ids.map((id) => [id, 0]));
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (pair.a === pair.b) return false;
    const key = unorderedKey(pair.a, pair.b);
    if (seen.has(key)) return false;
    seen.add(key);
    degrees.set(pair.a, (degrees.get(pair.a) ?? 0) + 1);
    degrees.set(pair.b, (degrees.get(pair.b) ?? 0) + 1);
  }
  return [...degrees.values()].every((degree) => degree === k);
}
