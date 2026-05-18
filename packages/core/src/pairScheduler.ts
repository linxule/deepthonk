import { ConfigError } from "./errors.js";
import type { Rng } from "./rng.js";

export interface Pair {
  a: string;
  b: string;
}

export function makeKRegularPairs(candidateIds: string[], k: number, rng: Rng): Pair[] {
  const ids = [...candidateIds];
  const n = ids.length;
  if (n < 2) throw new ConfigError("Pair scheduling requires at least two candidates.");
  if (k >= n) throw new ConfigError(`Invalid pair schedule: k (${k}) must be less than n (${n}).`);
  if ((n * k) % 2 !== 0) {
    throw new ConfigError(`Invalid pair schedule: n * k must be even, got ${n} * ${k}.`);
  }

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const stubs = rng.shuffle(ids.flatMap((id) => Array.from({ length: k }, () => id)));
    const pairs: Pair[] = [];
    const seen = new Set<string>();
    let ok = true;
    for (let i = 0; i < stubs.length; i += 2) {
      const a = stubs[i];
      const b = stubs[i + 1];
      const key = unorderedKey(a, b);
      if (a === b || seen.has(key)) {
        ok = false;
        break;
      }
      seen.add(key);
      pairs.push({ a, b });
    }
    if (ok && hasDegree(ids, pairs, k)) return pairs;
  }

  return greedyKRegular(ids, k, rng);
}

function greedyKRegular(ids: string[], k: number, rng: Rng): Pair[] {
  const remaining = new Map(ids.map((id) => [id, k]));
  const pairs: Pair[] = [];
  const seen = new Set<string>();

  while ([...remaining.values()].some((degree) => degree > 0)) {
    const available = [...remaining.entries()]
      .filter(([, degree]) => degree > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const a = available[0]?.[0];
    if (!a) break;
    const candidates = rng.shuffle(available.slice(1).map(([id]) => id)).sort((left, right) => {
      return (remaining.get(right) ?? 0) - (remaining.get(left) ?? 0) || left.localeCompare(right);
    });
    const b = candidates.find((id) => id !== a && !seen.has(unorderedKey(a, id)));
    if (!b) {
      throw new ConfigError(`Could not construct ${k}-regular pair schedule for ${ids.length} candidates.`);
    }
    seen.add(unorderedKey(a, b));
    remaining.set(a, (remaining.get(a) ?? 0) - 1);
    remaining.set(b, (remaining.get(b) ?? 0) - 1);
    pairs.push({ a, b });
  }

  if (!hasDegree(ids, pairs, k)) {
    throw new ConfigError(`Could not construct ${k}-regular pair schedule for ${ids.length} candidates.`);
  }
  return pairs;
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

