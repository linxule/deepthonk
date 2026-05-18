# DeepThonk Build Instructions

DeepThonk is a provider-neutral, OpenDeepThink-style reasoning optimizer exposed as a TypeScript CLI and MCP server.

Tagline: *thonk harder, not richer.*

Build and maintain the project around one shared execution engine in `packages/core`. The CLI and MCP server are wrappers over that engine; do not duplicate algorithm logic in those packages.

Core requirements:

- Implement population-based candidate generation, randomized pairwise comparison, Bradley-Terry aggregation, elite preservation, critique-guided mutation, bottom-quartile discard, and final dense ranking.
- Keep all model access behind the provider-neutral `ModelDriver` contract in `packages/providers`.
- Support `fake`, `openai-compatible`, and `deepseek` providers.
- Do not request hidden chain-of-thought. Ask models for final artifacts, concise rationales, critiques, and strict JSON where needed.
- Never log API keys or env var values. Do not write prompts or raw model output unless explicitly configured.
- MCP is a protocol wrapper over core execution, not a separate execution engine.
- Use `pnpm`, TypeScript, Vitest, Zod, Commander, `p-limit`, YAML, and the stable official MCP TypeScript SDK package `@modelcontextprotocol/sdk`.

Acceptance checks:

```bash
pnpm install
pnpm run build
pnpm test
pnpm --silent --filter @deepthonk/cli deepthonk plan --profile paper
rm -rf runs/test-quick
pnpm --silent --filter @deepthonk/cli deepthonk run --provider fake --profile quick --task examples/tasks/toy-math.txt --out runs/test-quick
pnpm --silent --filter @deepthonk/cli deepthonk inspect runs/test-quick
```
