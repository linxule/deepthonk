# Changelog

All notable changes to DeepThonk are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [0.1.0] — 2026-05-18

Initial public release. Independent TypeScript reimplementation of the OpenDeepThink algorithm (Zhou et al., 2026, [arXiv:2605.15177](https://arxiv.org/abs/2605.15177)). Reference Python implementation by the paper authors at [ZhouShang0817/open-deep-think](https://github.com/ZhouShang0817/open-deep-think) (MIT). DeepThonk vendors no source from the reference; it contributes the provider-neutral TypeScript core, MCP server, CLI, structured trace artifacts, and budget enforcement.

### Added — agent-composable surface

Every algorithm dimension is reachable inline through MCP arguments and CLI flags. No filesystem detours required for one-off agent prompt overrides.

- `deepthonk.run` / `deepthonk.start` accept optional `n`, `k`, `t`, `m`, `lambda`, `sample_temperature`, `mutate_temperature`, `judge_temperature`, `prompt_style`, `concurrency`, and per-phase `prompts` overrides.
- CLI mirrors with `--n`, `--k`, `--t`, `--m`, `--lambda`, per-phase `--*-temperature` flags, `--prompt-style`, `--prompts <yaml>`, and `--prompts-json <json>`.
- Per-phase prompt template overrides with `{task}`, `{rubric}`, `{candidate}`, `{candidateA}`, `{candidateB}`, `{critique}` variables, `{{` / `}}` escape, and fail-fast validation on unknown variables at run-start.
- Documentation in `docs/customization.md`.

### Added — npm publish

- Published to npm as `deepthonk` (CLI) plus `@deepthonk/core`, `@deepthonk/providers`, `@deepthonk/mcp`. Install: `npx -y deepthonk` or `npm install -g deepthonk`.
- README MCP install section restructured around `npx -y deepthonk serve-mcp` for Claude Code, Claude Desktop, Cursor, and generic stdio hosts.

### Added — engineering hardening

- Provider-neutral OpenDeepThink core (population-based generation, pairwise judging, Bradley-Terry ranking, critique-guided mutation, elite preservation, final dense ranking) in `packages/core`.
- DeepSeek, OpenRouter, and generic OpenAI-compatible providers in `packages/providers`.
- `deepthonk` CLI in `packages/cli` (`plan`, `run`, `inspect`, `resume`, `export`, `rank`, `mutate`, `setup`, `serve-mcp`).
- MCP server in `packages/mcp` with stdio and Streamable HTTP transports, exposing tools, resources, and prompt templates.
- Budget enforcement: call/input-token/output-token/USD caps with cache-hit/cache-miss DeepSeek pricing.
- Conservative resume: reports trace state but does not replay partial runs.
- `httpRetries` default of 12 with multiplicative ±20% jitter (matches reference Python's burst dispersion).
- Bradley-Terry score normalization via z-score (log compatibility with the reference Python implementation; rankings unchanged).
- Tiered pricing support: `longContextThresholdTokens` + `inputUsdPerMillionLong` + `outputUsdPerMillionLong` fields for Gemini/GPT-5.4-class long-context surcharge. Strict Zod refine requires the full set together.
- Per-call usage logged to `usage.jsonl` (phase/role/provider/model/tokens/USD/latency/retry). No prompt content.
- JSONL writes go through a per-trace serialization queue so concurrent appends never interleave; mid-run crashes preserve completed pairs.

### Security
- MCP Streamable HTTP transport enables DNS rebinding protection and validates the `Host` header against the loopback bind (CVE-2025-66414 / GHSA-w48q-cv73-mx4w class).
- Background MCP jobs (`deepthonk.start`) wrap their status-write handlers so a filesystem error inside the failure path no longer surfaces as an unhandled rejection.
- Process-level `unhandledRejection` guard in the CLI so a stray rejection logs to stderr instead of taking down the MCP server.
- `deepthonk setup` warns when `--api-key` is used directly (argv leaks via `ps` and shell history); `--api-key-stdin` and `--api-key-file` are the recommended paths.
- Dry-run secret redaction covers `authorization`, `bearer`, `cookie`, `credential` while keeping env-var metadata fields (`apiKeyEnv`, `apiKeyFile`) visible.
