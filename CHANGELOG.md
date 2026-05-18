# Changelog

All notable changes to DeepThonk are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [0.1.2] — 2026-05-19

### Added

- CLI profile registry CRUD: `deepthonk profile list`, `deepthonk profile show <name>`, `deepthonk profile save <name>`, and `deepthonk profile delete <name>`.
- MCP profile registry CRUD tools: `deepthonk.profile_list`, `deepthonk.profile_show`, `deepthonk.profile_save`, and `deepthonk.profile_delete`.
- Real resume replay. `deepthonk resume <run-dir> --continue` replays an interrupted run from the last durable phase boundary; MCP `deepthonk.resume` gains optional `continue: boolean`. Phase recovery is driven by new `phase.completed` events written at each phase boundary inside `runDeepThonk`. Cross-version (`resume.version_mismatch`, now semver-tolerant on same major.minor) and per-role provider mismatch refusals are explicit; pruning is crash-safe via a `.prune-in-progress` sentinel and rewrites both artifact JSONL files AND `events.jsonl`. A `claimRunLock` prevents concurrent resume races. Resume refuses to start when `config.json` lacks `output.*` fields rather than silently defaulting them.
- MCP Sampling provider. It is MCP-only, requires a sampling-capable client, treats model hints as preferences rather than enforcement, caps sampling concurrency at 4. Driver enforces `requestTimeoutMs` via `Promise.race` / `AbortController` and throws `provider.sampling_timeout` (non-retryable) on expiry. JSON extraction has a 128 KiB cap (`MAX_EXTRACTION_BYTES`) to defend against hostile or buggy hosts returning oversized responses. Host refusals surface as non-retryable `ProviderError` with an honest fix message pointing at `deepthonk resume --continue`. MCP `deepthonk.resume continue: true` of a sampling-based run threads `samplingContext` through and re-runs the capability check before constructing the driver.

### Changed

- `BudgetTracker` refuses to accept `maxInputTokens`, `maxOutputTokens`, or `maxUsd` when `provider == "sampling"` since MCP Sampling responses do not report token usage. The check fires at construction time before any provider call.
- Persistent invalid-JSON from the judge after retries exhausted now throws `judge.persistent_invalid_json` instead of synthesizing a tie. Eliminates a silent wrong-ranking pollution path under hostile or buggy judges.
- CLI `--provider sampling` (including via `--profile-name <sampling-profile>`) now throws a clean `provider.sampling_requires_mcp` ConfigError early instead of failing deep in the driver-construction path.

### Security

- `loadNamedProfile` raw-`api_key` rejection is now recursive across all nested fields (not just top-level + `providers.*`), matching the save side. Save path additionally rejects all secret-shaped keys (`token`, `secret`, `password`, `authorization`, `bearer`, `cookie`, `credential`) recursively at any depth; CLI `--from-config` benefits from the same rejection.
- MCP `profile_save` arg schema is `.strict()` instead of `.passthrough()` so misspelled keys produce a clear validation error rather than landing in the profile YAML as silent metadata.
- Profile-save validation runs in-memory via `validateNamedProfileBundle` instead of writing a temporary profile into `~/.config/deepthonk/profiles/`; eliminates the crash-leaves-pollution failure mode.

## [0.1.1] — 2026-05-18

### Added — agent polish

- Named profile registry. Save reusable bundles at `~/.config/deepthonk/profiles/<name>.yaml` and load them with `--profile-name <name>` (CLI) or `profile_name: "<name>"` (MCP, on `run`, `start`, `plan`, `rank`, `mutate`). Mutually exclusive with `--config`/`config_path`. CLI flags and MCP inline args still override fields inside the named profile. Standalone bundle schema requires `profile` or `algorithm` block, `prompt_style`, `provider`, and at least `models.{generator,mutator,judge}`; raw `api_key` values are rejected at load time. `DEEPTHONK_PROFILES_DIR` overrides the registry directory. Documented in `docs/customization.md` with the `examples/profiles/legal-drafting.yaml` example.
- `summary.json` now includes the resolved `profile`, `profile_name`, `prompt_style`, and per-role `models` so inspect-time consumers no longer have to read both `summary.json` and `config.json`.
- Per-phase variable descriptions on the MCP `prompts` schema. Each phase (`generate`, `compare`, `mutate`, `finalize`) documents its valid variables and, for `compare`, the strict JSON output contract.

### Added — runtime hardening

- Added `schema_version: 1` to every `usage.jsonl` row for forward compatibility.

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
