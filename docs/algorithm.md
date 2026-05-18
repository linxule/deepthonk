# Algorithm Notes

The algorithm and its benchmark results are from:

> Shang Zhou, Wenhao Chai, Kaiyuan Liu, Huanzhi Mao, Qiuyang Mang, Jingbo Shang. *OpenDeepThink: Parallel Reasoning via Bradley–Terry Aggregation*. arXiv:2605.15177, 2026. <https://arxiv.org/abs/2605.15177>

Reference Python implementation: <https://github.com/ZhouShang0817/open-deep-think> (MIT). DeepThonk is an independent TypeScript reimplementation; the notes below describe the loop as implemented here, which mirrors the paper.

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

The optional `finalizerModel` post-processing step is a DeepThonk extension, not part of the paper's Algorithm 1. The paper returns the Bradley-Terry top of the final population directly as the answer. When `finalizerModel` is set, DeepThonk performs one additional model call to post-process the ranked winner; leave it unset to mirror the paper exactly.

Note: the BT score normalization in `packages/core/src/bradleyTerry.ts` z-scores the output to match the reference Python implementation's logging convention. The paper specifies raw L2-regularized MLE; both transforms produce identical rankings, but absolute score magnitudes will match the reference repo, not the paper.
