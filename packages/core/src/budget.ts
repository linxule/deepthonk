import { ConfigError } from "./errors.js";
import type { BuiltInProfileName, Profile } from "./schemas.js";
import { builtInProfiles } from "./schemas.js";

export interface BudgetPlan {
  profile?: BuiltInProfileName | "custom";
  calls: number;
  initial_generate_calls: number;
  per_generation_judge_calls: number;
  per_generation_mutate_calls: number;
  final_judge_calls: number;
  sequential_rounds: number;
  warnings: string[];
}

export function getProfile(profile: BuiltInProfileName | Profile): Profile {
  if (typeof profile !== "string") return profile;
  const value = builtInProfiles[profile];
  if (!value) throw new ConfigError(`Unknown profile: ${profile}. Use quick, balanced, or paper.`);
  return value;
}

export function validateProfile(profile: Profile): void {
  if (profile.k >= profile.n) throw new ConfigError(`Profile invalid: k (${profile.k}) must be less than n (${profile.n}).`);
  if (profile.m >= profile.n) throw new ConfigError(`Profile invalid: m (${profile.m}) must be less than n (${profile.n}).`);
  if ((profile.n * profile.k) % 2 !== 0) throw new ConfigError(`Profile invalid: n*k must be even, got ${profile.n * profile.k}.`);
  if ((profile.n * profile.m) % 2 !== 0) throw new ConfigError(`Profile invalid: n*m must be even, got ${profile.n * profile.m}.`);
}

export function planBudget(profileInput: BuiltInProfileName | Profile): BudgetPlan {
  const profile = getProfile(profileInput);
  validateProfile(profile);
  const profileName = typeof profileInput === "string" ? profileInput : "custom";
  const eliteCount = Math.ceil(profile.n / 4);
  const mutateCount = profile.n - eliteCount;
  const perGenerationJudge = (profile.n * profile.k) / 2;
  const finalJudge = (profile.n * profile.m) / 2;
  const calls = profile.n + profile.t * (perGenerationJudge + mutateCount) + finalJudge;
  return {
    profile: profileName,
    calls,
    initial_generate_calls: profile.n,
    per_generation_judge_calls: perGenerationJudge,
    per_generation_mutate_calls: mutateCount,
    final_judge_calls: finalJudge,
    sequential_rounds: 1 + profile.t * 2 + 1,
    warnings: calls >= 100 ? ["High call count; confirm provider cost limits before running."] : []
  };
}
