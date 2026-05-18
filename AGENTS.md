# DeepThonk Build Instructions

DeepThonk is a provider-neutral, OpenDeepThink-style reasoning optimizer exposed as a TypeScript CLI and MCP server.

The algorithm is from Zhou et al. 2026 (*OpenDeepThink: Parallel Reasoning via Bradley–Terry Aggregation*, [arXiv:2605.15177](https://arxiv.org/abs/2605.15177)); the authors' Python reference implementation is at <https://github.com/ZhouShang0817/open-deep-think> (MIT). DeepThonk is an independent TypeScript reimplementation — not a fork, no code vendored from the reference.

Tagline: *thonk harder, not richer.*

Build and maintain the project around one shared execution engine in `packages/core`. The CLI and MCP server are wrappers over that engine; do not duplicate algorithm logic in those packages.

Design principle: **agent-composable surface**. Every algorithm dimension — population shape (`n`, `k`, `t`, `m`), regularization (`lambda`), temperatures, prompt style, and per-phase prompt templates — must be reachable inline through MCP tool arguments and CLI flags, not only through YAML files. Inspection of every intermediate artifact must remain available as MCP resources. See `docs/customization.md` for the variable contract.

Core requirements:

- Implement population-based candidate generation, randomized pairwise comparison, Bradley-Terry aggregation, elite preservation, critique-guided mutation, bottom-quartile discard, and final dense ranking.
- Keep all model access behind the provider-neutral `ModelDriver` contract in `packages/providers`.
- Support `fake`, `openai-compatible`, and `deepseek` providers.
- Do not request hidden chain-of-thought. Ask models for final artifacts, concise rationales, critiques, and strict JSON where needed.
- Never log API keys or env var values. Do not write prompts or raw model output unless explicitly configured.
- MCP is a protocol wrapper over core execution, not a separate execution engine.
- The Streamable HTTP transport must keep DNS rebinding protection on and validate `Host` against the loopback bind (CVE-2025-66414 class). Do not remove that guard when extending the transport.
- Background MCP jobs (`deepthonk.start`) must wrap both their success and failure handlers so a filesystem error cannot escape as an unhandled rejection.
- Use `pnpm`, TypeScript, Vitest, Zod, Commander, `p-limit`, YAML, and the stable official MCP TypeScript SDK package `@modelcontextprotocol/sdk`.

Acceptance checks:

```bash
pnpm install
pnpm run build
pnpm test
pnpm --silent --filter deepthonk deepthonk plan --profile paper
rm -rf runs/test-quick
pnpm --silent --filter deepthonk deepthonk run --provider fake --profile quick --task examples/tasks/toy-math.txt --out runs/test-quick
pnpm --silent --filter deepthonk deepthonk inspect runs/test-quick
```
