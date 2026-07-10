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

> v0.1 scope: an independent TypeScript reimplementation of the OpenDeepThink algorithm as a CLI + MCP server. The published algorithm is the load-bearing part; this release is a practical integration layer with explicit limits documented below. Cost guarantees rely on provider pricing being present in config; resume inspects trace state by default and can replay from validated phase boundaries with `--continue` / MCP `continue: true`; the MCP HTTP transport is loopback-only. The included acceptance smoke uses the deterministic fake provider and a toy task — it is not a CF-73 / HLE reproduction; see `docs/` and [Acknowledgments](#acknowledgments) for the canonical paper and Python reference.

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

Start with `--profile quick` and consider `--max-concurrency`, `--max-calls`, `--max-input-tokens`, `--max-output-tokens`, `--max-usd`, and `--request-timeout-ms` before larger paid profiles. `max_calls` is reserved before dispatch and counts logical model invocations, including failed calls and invalid-JSON retries; provider-internal HTTP retries are reported separately. Token/USD totals are known only after responses and can overshoot by at most the active concurrency window. Plans keep nominal `calls` separate from finalizer and retry headroom in `worst_case_calls`.

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

MCP Sampling is supported over stdio as `provider: "sampling"` when the connected host advertises the MCP sampling capability. The v0.1 patch line rejects Sampling over Streamable HTTP and all mixed Sampling/direct role routes; use a direct provider there. Sampling is not available from standalone CLI runs.

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

The server binds `127.0.0.1:3333` only and exposes stateful `POST`, `GET`, and `DELETE` at `http://127.0.0.1:3333/mcp`. Sessions use cryptographic IDs, expire after 30 idle minutes when no request is active, and are capped at 64. DNS rebinding protection is on (CVE-2025-66414): requests with `Host` headers outside `127.0.0.1:3333` / `localhost:3333` are rejected. The wrapper also rejects non-JSON POSTs, non-loopback `Origin` headers, and `Sec-Fetch-Site: cross-site` before reading the body. It has no bearer auth. Do not expose this port through a reverse proxy without re-evaluating that trust boundary.

### Tools

| Tool | Purpose |
|---|---|
| `deepthonk.plan` | Estimate calls and sequential rounds for a profile (no model calls). Use before paid runs. |
| `deepthonk.start` | Start a run in the background; returns `run_dir`, `job_id`, and job-scoped artifact resources. |
| `deepthonk.status` | Poll job status from a `run_dir`. |
| `deepthonk.result` | Return final summary + winner once a job is complete. |
| `deepthonk.cancel` | Request cancellation by writing `cancel.json` into the run directory. |
| `deepthonk.lock_inspect` / `deepthonk.lock_reclaim` | Inspect lock ownership and explicitly reclaim only an exact fingerprint. |
| `deepthonk.repair_budget` | Replace legacy `[redacted]` numeric budget fields with explicit original values. |
| `deepthonk.run` | Blocking convenience: start + await completion in one call. Prefer `start` + polling for long-running jobs. |
| `deepthonk.rank` | Rank a user-supplied candidate set with pairwise judging + Bradley-Terry (skip generation). |
| `deepthonk.mutate` | Mutate one supplied candidate with critique (one-shot). |
| `deepthonk.resume` | Detect whether a run can be resumed; with `continue: true`, replay from the last validated phase boundary. |
| `deepthonk.export` | Export run summary or full trace in JSON or markdown. |
| `deepthonk.profile_list` | List saved named profile bundles. |
| `deepthonk.profile_show` | Show one saved profile; manually edited secret-shaped values are rejected on load. |
| `deepthonk.profile_save` | Save a reusable named profile bundle. |
| `deepthonk.profile_delete` | Delete a saved named profile bundle. |

All tools accept inline provider/model fields, or `config_path` pointing at a DeepThonk YAML config.

### Resources

- `deepthonk://runs` — JSON index of all runs in `runs/`.
- `deepthonk://runs/{run_id}/summary` — run summary (JSON).
- `deepthonk://runs/{run_id}/config` — redacted run config (JSON).
- `deepthonk://runs/{run_id}/{candidates|comparisons|scores|usage|trace}` — per-phase and per-call NDJSON.
- `deepthonk://runs/{run_id}/population/{generation}` — population snapshot for a generation (JSON).
- `deepthonk://runs/{run_id}/{winner|final}` — text artifacts.
- `deepthonk://runs/{run_id}/status` — run state (JSON).
- `deepthonk://jobs/{job_id}/{status|result|config|candidates|comparisons|scores|usage|trace|final|winner}?run_dir=...` — job-scoped lookup; the `run_dir` query param is required.
- `deepthonk://jobs/{job_id}/population/{generation}?run_dir=...` — job-scoped population snapshots before or after completion.
- `deepthonk://runs/{run_id}/{resource}/page/{cursor}` and job equivalents — opaque bounded pages. Whole reads are limited to 1 MiB; pages contain at most 1,000 records and 1 MiB.

### Prompts

Four templates mirror the core loop: `deepthonk/generate`, `deepthonk/compare`, `deepthonk/mutate`, `deepthonk/finalize`. Hosts can render them directly to drive the algorithm by hand without invoking the tool surface.

### Limits

`deepthonk.resume` reports trace state by default. With `continue: true`, it validates phase order, artifacts, run/provider/model identity, scores, usage, and deterministic pair schedules before replaying a complete phase boundary. MCP Sampling model hints are preferences, token usage may be unavailable, and stdio Sampling concurrency is capped at 4. Streamable HTTP in v0.1 supports direct providers only.

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

Save reusable bundles as **named profiles** at `~/.config/deepthonk/profiles/<name>.yaml` and load them with `--profile-name <name>` (CLI) or `profile_name: "<name>"` (MCP). A named profile is a standalone bundle that replaces the main config file for that run; CLI flags and MCP inline arguments still override fields inside it. See `examples/profiles/legal-drafting.yaml` for the shape. The [Customization guide](https://github.com/linxule/deepthonk/blob/main/docs/customization.md#managing-named-profiles) covers listing, showing, saving, and deleting named profiles from both CLI and MCP.

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
  population-0.json
  population-{generation}.json
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

Release publishing is tag-triggered through npm Trusted Publishing. See [docs/release.md](https://github.com/linxule/deepthonk/blob/main/docs/release.md) before bumping versions or pushing a `v*` tag.

Known limits for this release:

- Conservative v1 resume replays an interrupted phase wholesale, preserves its usage accounting, and only reuses validated completed phase boundaries.
- MCP Sampling is stdio-host-only in v0.1. Standalone CLI and Streamable HTTP runs need a direct provider.
- `maxUsd` requires known model pricing; add explicit prices in YAML for custom providers and model IDs. Optional fields `longContextThresholdTokens`, `inputUsdPerMillionLong`, and `outputUsdPerMillionLong` enable tiered pricing for models with a long-context surcharge (e.g., Gemini at 200K input tokens). Cache hit/miss rates remain flat.

## Acknowledgments

DeepThonk is an independent TypeScript reimplementation of the OpenDeepThink algorithm. It is not a fork; no source code from the reference implementation is vendored. Credit for the algorithm, the benchmark methodology, and the empirical results belongs to the paper authors.

- **Paper**: Shang Zhou, Wenhao Chai, Kaiyuan Liu, Huanzhi Mao, Qiuyang Mang, Jingbo Shang. *OpenDeepThink: Parallel Reasoning via Bradley–Terry Aggregation*. arXiv:2605.15177, 2026. <https://arxiv.org/abs/2605.15177>
- **Reference Python implementation**: <https://github.com/ZhouShang0817/open-deep-think> (MIT). This is the authors' code release and the canonical implementation for reproducing paper results (CF-73, HLE).

DeepThonk's contribution is an integration layer: a provider-neutral TypeScript core, an MCP server, a CLI, structured trace artifacts, and budget enforcement. The algorithm itself is theirs.
