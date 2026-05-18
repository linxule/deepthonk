export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  bool(): boolean;
  id(prefix: string): string;
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(maxExclusive: number) {
      return Math.floor(next() * maxExclusive);
    },
    bool() {
      return next() >= 0.5;
    },
    id(prefix: string) {
      return `${prefix}_${Math.floor(next() * 0xffffffff).toString(36).padStart(7, "0")}`;
    },
    shuffle<T>(items: readonly T[]) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    }
  };
}

