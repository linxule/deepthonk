# Algorithm Notes

DeepThonk follows the OpenDeepThink loop:

1. Generate `n` independent candidates.
2. Run randomized pairwise comparisons.
3. Fit Bradley-Terry scores from noisy pairwise outcomes.
4. Copy the top quartile as elites.
5. Mutate the top 75% using aggregated critiques.
6. Drop the bottom quartile.
7. Repeat for `T` generations.
8. Run a denser final comparison round and return the top candidate.

The default paper profile is `n=20`, `k=4`, `t=3`, `m=10`, which yields 285 calls.

When selected through the CLI/MCP `paper` profile, DeepThonk uses a `paper-programming` prompt style that mirrors the paper's competitive-programming benchmark orientation. Other profiles use the provider-neutral general prompts.

For profiles where `n` is not divisible by four, DeepThonk avoids creating extra mutants that would be immediately truncated. The paper setting is divisible by four, so this does not affect paper-profile accounting.
