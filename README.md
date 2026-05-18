# DeepThonk

*thonk harder, not richer.*

DeepThonk implements OpenDeepThink (arXiv:2605.15177) as a budget-friendly, provider-neutral "deep think / pro mode" wrapper, with first-class DeepSeek support.

DeepThonk runs a population of candidate answers through pairwise judging, Bradley-Terry ranking, critique-guided mutation, elite preservation, and a final dense ranking pass. The CLI and MCP server both call the same TypeScript core engine.

Use it for hard, verifiable reasoning, coding, planning, and synthesis where breadth plus judgment can beat one expensive single shot. Avoid it for highly subjective tasks where judge noise dominates.

## Quickstart

```bash
pnpm install
pnpm run build
pnpm --silent --filter @deepthonk/cli deepthonk plan --profile paper
rm -rf runs/test-quick
pnpm --silent --filter @deepthonk/cli deepthonk run --provider fake --profile quick --task examples/tasks/toy-math.txt --out runs/test-quick
pnpm --silent --filter @deepthonk/cli deepthonk inspect runs/test-quick
```

The paper profile plans 285 model calls and 8 sequential rounds. Confirm budget and provider pricing before pointing it at paid models.
When running from a clone, `pnpm --silent --filter @deepthonk/cli deepthonk ...` keeps stdout parseable as JSON. After global install or linking, use bare `deepthonk`.

## Setup

Create a reusable local config:

```bash
deepthonk setup \
  --provider deepseek \
  --api-key-env DEEPSEEK_API_KEY \
  --fast-model deepseek-v4-flash \
  --judge-model deepseek-v4-pro
```

By default this writes `~/.config/deepthonk/config.yaml`. `deepthonk run` loads that file automatically when `--config` is not supplied. If you pass `--api-key`, setup stores it in `~/.config/deepthonk/env`; otherwise it uses the named environment variable from your shell.

## DeepSeek

```bash
export DEEPSEEK_API_KEY=...
deepthonk run \
  --task task.md \
  --profile paper \
  --provider deepseek \
  --generator-model deepseek-v4-flash \
  --mutator-model deepseek-v4-flash \
  --judge-model deepseek-v4-pro \
  --out runs/task-paper
```

DeepSeek is implemented as an OpenAI-compatible profile using `https://api.deepseek.com/v1`. DeepThonk ships default USD pricing for `deepseek-v4-flash` and `deepseek-v4-pro` from the official DeepSeek pricing page, including cache-hit/cache-miss input rates. Model names and prices are still editable config because both can change.

Before paid runs, inspect cost shape and resolved config:

```bash
deepthonk plan --config ~/.config/deepthonk/config.yaml
deepthonk run --task task.md --config ~/.config/deepthonk/config.yaml --profile quick --dry-run
```

Start with `--profile quick` and consider `--max-concurrency`, `--max-input-tokens`, `--max-output-tokens`, `--max-usd`, and `--request-timeout-ms` before larger paid profiles. Runtime token/USD budgets are enforced after completed provider calls and can overshoot by at most the active concurrency window. Every completed run summary includes call/token usage, and includes `usage.usd` when matching model pricing is available.

## OpenAI-Compatible Providers

```bash
export DEEPTHONK_API_KEY=...
deepthonk run \
  --task task.md \
  --profile balanced \
  --provider openai-compatible \
  --base-url https://provider.example.com/v1 \
  --api-key-env DEEPTHONK_API_KEY \
  --generator-model cheap-model \
  --judge-model strong-model
```

The driver calls `POST {base_url}/chat/completions` and uses JSON mode for comparisons when supported. If a provider rejects JSON mode, the driver falls back to plain text plus robust JSON extraction.

Provider names are flexible. For a custom OpenAI-compatible endpoint, use any provider label with `--base-url`, `--api-key-env`, and role-specific model flags. For OpenRouter:

```bash
export OPENROUTER_API_KEY=...
deepthonk run \
  --task task.md \
  --profile balanced \
  --provider openrouter \
  --generator-model openrouter/auto \
  --mutator-model openrouter/auto \
  --judge-model openrouter/auto
```

For mixed-provider runs, use YAML config and override individual roles under `providers`, especially `judge`.

Optional `finalizer_model` / `--finalizer-model` can post-process the ranked winner. Leave it unset when you want the raw ranked answer as the final artifact.

## MCP

```bash
deepthonk serve-mcp --transport stdio
```

Configure your MCP host to launch that command. MCP exposes tools, resources, and prompts over the same engine used by the CLI. Streamable HTTP is also available at `/mcp`:

```bash
deepthonk serve-mcp --transport http --port 3333
```

MCP Sampling is deferred and is not exposed as a provider mode yet. Direct provider mode works independently of host model support.
MCP tools accept inline provider/model fields, or `config_path` pointing at a DeepThonk YAML config. Host processes still need the relevant API-key environment variables. For long agent workflows, prefer `deepthonk.start`, then poll `deepthonk.status` and read `deepthonk.result`; `deepthonk.run` remains the blocking convenience wrapper.

## Trace Files

Each run writes:

```txt
runs/{run_id}/
  config.json
  events.jsonl
  candidates.jsonl
  comparisons.jsonl
  scores.jsonl
  status.json
  cancel.json
  summary.json
  artifacts/winner.txt
  artifacts/final.txt
```

Prompts and raw model outputs are off by default. API keys are never written. Candidate answers, critiques, scores, and final artifacts are trace data and are stored/exported by design, so do not use a shared run directory for sensitive tasks unless that is acceptable.

## Development

```bash
pnpm install
pnpm run build
pnpm test
pnpm run lint
```

This repository is source-only. Generated run traces, paper notes, build output, coverage, logs, and `node_modules` are intentionally ignored.

Known limits for this release:

- Conservative resume reports trace state and safe phase boundaries, but does not replay interrupted runs yet.
- MCP Sampling is deferred until there is a real host-backed Sampling driver.
- `maxUsd` requires known model pricing; add explicit prices in YAML for custom providers and model IDs.
