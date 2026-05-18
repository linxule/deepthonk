# DeepThonk

*thonk harder, not richer.*

DeepThonk implements the OpenDeepThink algorithm (Zhou et al., 2026, [arXiv:2605.15177](https://arxiv.org/abs/2605.15177)) as a budget-friendly, provider-neutral "deep think / pro mode" wrapper, with first-class DeepSeek support. See [Acknowledgments](#acknowledgments).

DeepThonk runs a population of candidate answers through pairwise judging, Bradley-Terry ranking, critique-guided mutation, elite preservation, and a final dense ranking pass. The CLI and MCP server both call the same TypeScript core engine.

**Designed for agents.** Every algorithm dimension — population shape (`n`, `k`, `t`, `m`), regularization (`lambda`), per-phase temperatures, prompt style, and per-phase prompt templates — is reachable inline through MCP arguments and CLI flags. CLI can load prompt files with `--prompts` or inline JSON with `--prompts-json`; MCP accepts inline structured prompt args. Every intermediate artifact (config, candidates, populations, comparisons, scores, per-call usage, status) is exposed as an MCP resource so an agent can inspect any step. See [Customization](https://github.com/linxule/deepthonk/blob/main/docs/customization.md) for the full agent-composable surface.

Use it for hard, verifiable reasoning, coding, planning, and synthesis where breadth plus judgment can beat one expensive single shot. Avoid it for highly subjective tasks where judge noise dominates.

## Quickstart

Run without installing:

```bash
npx -y deepthonk plan --profile paper
npx -y deepthonk run --provider fake --profile quick \
  --task "Find the smallest positive integer divisible by 3, 4, and 5." \
  --out runs/test-quick
npx -y deepthonk inspect runs/test-quick
```

Or install globally:

```bash
npm install -g deepthonk
deepthonk plan --profile paper
```

The paper profile plans 285 model calls and 8 sequential rounds. Confirm budget and provider pricing before pointing it at paid models. The short alias `dt` is installed alongside `deepthonk`. Develop from source: see [Development](#development).

> v0.1 scope: an independent TypeScript reimplementation of the OpenDeepThink algorithm as a CLI + MCP server. The published algorithm is the load-bearing part; this release is a practical integration layer with explicit limits documented below. Cost guarantees rely on provider pricing being present in config; resume only inspects trace state, it does not replay; the MCP HTTP transport is loopback-only. The included acceptance smoke uses the deterministic fake provider and a toy task — it is not a CF-73 / HLE reproduction; see `docs/` and [Acknowledgments](#acknowledgments) for the canonical paper and Python reference.

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

The driver calls `POST {base_url}/chat/completions` and requests JSON mode for comparisons when supported. If a provider returns a `400` with a body that mentions `response_format` or `json`, the driver retries without JSON mode and uses robust JSON extraction on the plain text response. Providers that reject JSON mode with a different status code (e.g. `422`) surface as a normal provider error — set `supportsJsonMode: false` in YAML to disable JSON mode up front.

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

The MCP server exposes the same engine the CLI runs. Once wired into an MCP host, the host can plan budgets, kick off background runs, poll status, fetch winners, and stream structured trace artifacts — all through MCP tools, resources, and prompts.

Provider API keys come from the host process's environment, not from DeepThonk's config alone. Each host handles env passthrough slightly differently — see the concrete patterns below.

### Claude Code

```bash
claude mcp add deepthonk \
  -e DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY \
  -- npx -y deepthonk serve-mcp --transport stdio
```

Use `-s user` for cross-project scope or `-s project` to commit registration into `.claude/`. Verify with `claude mcp list`. See `claude mcp --help` for the authoritative flag set.

### Claude Desktop

Config path: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/.config/Claude/claude_desktop_config.json` (Linux). Add:

```json
{
  "mcpServers": {
    "deepthonk": {
      "command": "npx",
      "args": ["-y", "deepthonk", "serve-mcp", "--transport", "stdio"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-..."
      }
    }
  }
}
```

Restart Claude Desktop after editing.

### Cursor

Project-scoped: `.cursor/mcp.json` in the workspace. User-global: `~/.cursor/mcp.json`. Same JSON shape as Claude Desktop:

```json
{
  "mcpServers": {
    "deepthonk": {
      "command": "npx",
      "args": ["-y", "deepthonk", "serve-mcp", "--transport", "stdio"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

### Other MCP hosts (stdio)

Any host that speaks MCP stdio launches:

```bash
npx -y deepthonk serve-mcp --transport stdio
```

with the relevant provider env vars set on the process. If you'd rather install globally, `npm install -g deepthonk` then use `command: "deepthonk"` directly. Refer to the host's MCP registration docs for the configuration shape.

### Streamable HTTP

For local web hosts, or when stdio isn't available:

```bash
deepthonk serve-mcp --transport http --port 3333
```

The server binds `127.0.0.1:3333` only (loopback) and the endpoint is `POST http://127.0.0.1:3333/mcp`. DNS rebinding protection is on (CVE-2025-66414): requests with `Host` headers outside `127.0.0.1:3333` / `localhost:3333` are rejected. Do not expose this port through a reverse proxy without re-evaluating that trust boundary.

### Tools

| Tool | Purpose |
|---|---|
| `deepthonk.plan` | Estimate calls and sequential rounds for a profile (no model calls). Use before paid runs. |
| `deepthonk.start` | Start a run in the background; returns `run_dir` + `job_id`. |
| `deepthonk.status` | Poll job status from a `run_dir`. |
| `deepthonk.result` | Return final summary + winner once a job is complete. |
| `deepthonk.cancel` | Request cancellation by writing `cancel.json` into the run directory. |
| `deepthonk.run` | Blocking convenience: start + await completion in one call. Prefer `start` + polling for long-running jobs. |
| `deepthonk.rank` | Rank a user-supplied candidate set with pairwise judging + Bradley-Terry (skip generation). |
| `deepthonk.mutate` | Mutate one supplied candidate with critique (one-shot). |
| `deepthonk.resume` | Detect whether a run can be resumed. Reports state only; does not replay yet. |
| `deepthonk.export` | Export run summary or full trace in JSON or markdown. |

All tools accept inline provider/model fields, or `config_path` pointing at a DeepThonk YAML config.

### Resources

- `deepthonk://runs` — JSON index of all runs in `runs/`.
- `deepthonk://runs/{run_id}/summary` — run summary (JSON).
- `deepthonk://runs/{run_id}/config` — redacted run config (JSON).
- `deepthonk://runs/{run_id}/{candidates|comparisons|scores|usage|trace}` — per-phase and per-call NDJSON.
- `deepthonk://runs/{run_id}/population/{generation}` — population snapshot for a generation (JSON).
- `deepthonk://runs/{run_id}/{winner|final}` — text artifacts.
- `deepthonk://runs/{run_id}/status` — run state (JSON).
- `deepthonk://jobs/{job_id}/{status|result}?run_dir=...` — job-scoped lookup; the `run_dir` query param is required.

### Prompts

Four templates mirror the core loop: `deepthonk/generate`, `deepthonk/compare`, `deepthonk/mutate`, `deepthonk/finalize`. Hosts can render them directly to drive the algorithm by hand without invoking the tool surface.

### Limits

MCP Sampling is deferred and not exposed as a provider mode — direct provider mode is the only option in v0.1. `deepthonk.resume` reports trace state and safe phase boundaries but does not replay interrupted runs. The HTTP transport is loopback-only by design.

## Customization

Every algorithm dimension is reachable through MCP arguments and CLI flags:

- **Population shape**: `n`, `k`, `t`, `m` — override profile defaults inline.
- **Algorithm constants**: `lambda`, `sample_temperature`, `mutate_temperature`, `judge_temperature`.
- **Prompt style**: `general` or `paper-programming`.
- **Per-phase prompt templates**: override `generate`, `compare`, `mutate`, or `finalize` with custom system/user templates and variable substitution (`{task}`, `{rubric}`, `{candidate}`, `{candidateA}`, `{candidateB}`, `{critique}`). CLI supports `--prompts <yaml>` and `--prompts-json <json>`; MCP supports inline `prompts`. Unknown variables throw a fail-fast error at run-start.
- **Concurrency**: per-phase caps for `generate`, `judge`, `mutate`.

Example agent call (MCP), no YAML file required:

```json
{
  "task": "Draft a concise non-solicitation clause for a senior sales employee.",
  "profile": "balanced",
  "n": 6, "t": 1,
  "provider": "deepseek",
  "judge_model": "deepseek-v4-pro",
  "prompts": {
    "generate": { "system": "You are an experienced employment-law attorney." },
    "compare":  { "system": "Prefer enforceable clauses under California law. Return strict JSON only." }
  }
}
```

CLI accepts the same surface. Use `--prompts <yaml>` for reusable prompt files or `--prompts-json <json>` for one-off inline overrides. MCP and CLI both merge over any `--config`/`config_path` YAML defaults.

Save reusable bundles as **named profiles** at `~/.config/deepthonk/profiles/<name>.yaml` and load them with `--profile-name <name>` (CLI) or `profile_name: "<name>"` (MCP). A named profile is a standalone bundle that replaces the main config file for that run; CLI flags and MCP inline arguments still override fields inside it. See `examples/profiles/legal-drafting.yaml` for the shape.

See the [Customization guide](https://github.com/linxule/deepthonk/blob/main/docs/customization.md) for the complete variable contract, the compare-phase JSON safety rule, the named-profile schema, and three worked examples. Per-role provider routing (`providers.judge.provider = openrouter`) and per-model pricing remain YAML-only — they're nested structured config, not inline ergonomics.

## Trace Files

A successful run writes:

```txt
runs/{run_id}/
  config.json
  events.jsonl
  candidates.jsonl
  comparisons.jsonl
  scores.jsonl
  usage.jsonl
  summary.json
  artifacts/winner.txt
  artifacts/final.txt
```

`status.json` is written when the run is launched through MCP `deepthonk.start` (so async clients can poll). `cancel.json` is written only when cancellation is requested. A `run.lock` file is held for the duration of the run.

JSONL writes are streamed as each candidate / comparison / call completes, and all appends go through a per-trace serialization queue. If a run is killed mid-tournament, completed pairs are durable on disk and the JSONL files remain readable.

`usage.jsonl` carries one row per provider call (generator, judge, mutator, finalizer) with phase/role/provider/model/token/USD/latency/retry. It contains no prompt content. `jq` over `usage.jsonl` is the simplest way to break a run's cost down by role.

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
- `maxUsd` requires known model pricing; add explicit prices in YAML for custom providers and model IDs. Optional fields `longContextThresholdTokens`, `inputUsdPerMillionLong`, and `outputUsdPerMillionLong` enable tiered pricing for models with a long-context surcharge (e.g., Gemini at 200K input tokens). Cache hit/miss rates remain flat.

## Acknowledgments

DeepThonk is an independent TypeScript reimplementation of the OpenDeepThink algorithm. It is not a fork; no source code from the reference implementation is vendored. Credit for the algorithm, the benchmark methodology, and the empirical results belongs to the paper authors.

- **Paper**: Shang Zhou, Wenhao Chai, Kaiyuan Liu, Huanzhi Mao, Qiuyang Mang, Jingbo Shang. *OpenDeepThink: Parallel Reasoning via Bradley–Terry Aggregation*. arXiv:2605.15177, 2026. <https://arxiv.org/abs/2605.15177>
- **Reference Python implementation**: <https://github.com/ZhouShang0817/open-deep-think> (MIT). This is the authors' code release and the canonical implementation for reproducing paper results (CF-73, HLE).

DeepThonk's contribution is an integration layer: a provider-neutral TypeScript core, an MCP server, a CLI, structured trace artifacts, and budget enforcement. The algorithm itself is theirs.
