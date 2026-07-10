# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DeepThonk implements OpenDeepThink as a provider-neutral TypeScript CLI + MCP server. A single shared engine in `packages/core` drives a population-based reasoning loop: generate → pairwise judge → Bradley-Terry rank → critique-guided mutation with elite preservation → final dense ranking. See `AGENTS.md` for the build contract and `docs/algorithm.md` for the loop details.

## Toolchain

Uses `pnpm` workspaces (not bun) — pinned to `pnpm@11.8.0` via the root `packageManager` field (pnpm 11 requires **Node ≥ 22.13** and is needed for OIDC trusted publishing). Node ESM (`"type": "module"`). TypeScript 7 with project references; tests use Vitest 4 with path aliases that resolve `@deepthonk/*` to `packages/*/src` so tests run against source, not built `dist/`. `pnpm-workspace.yaml` sets `allowBuilds: { esbuild: true }` (pnpm 11 errors on unapproved build scripts). CI runs Node 22 and 24; `@types/node` stays on `^22` to match the floor.

## Commands

```bash
pnpm install
pnpm run build              # tsc per workspace package
pnpm test                   # vitest run (all packages)
pnpm run lint               # typecheck only — no separate linter
pnpm run typecheck          # same as lint

# Single test file or test
pnpm exec vitest run test/core/runner.test.ts
pnpm exec vitest run -t "name pattern"

# Per-package build/typecheck
pnpm --filter @deepthonk/core run build
pnpm --filter deepthonk run typecheck

# CLI (from clone, --silent keeps stdout JSON-parseable)
pnpm --silent --filter deepthonk deepthonk plan --profile paper
pnpm --silent --filter deepthonk deepthonk run \
  --provider fake --profile quick \
  --task examples/tasks/toy-math.txt --out runs/test-quick
pnpm --silent --filter deepthonk deepthonk inspect runs/test-quick

# Dev CLI without building
pnpm --filter deepthonk run deepthonk -- plan --profile quick
```

The CLI also exposes `dt` as a short alias once installed. Built bin is `packages/cli/dist/index.js`.

## Architecture

Four workspace packages, all `@deepthonk/*`:

- **`packages/core`** — algorithm engine. `runner.ts` orchestrates the OpenDeepThink loop; `bradleyTerry.ts` fits scores; `pairScheduler.ts` builds k-regular comparison graphs; `critique.ts` aggregates judge feedback per candidate; `budget.ts` + `budgetTracker.ts` plan/enforce call/token/USD caps; `traceStore.ts` writes the run directory layout (`config.json`, `events.jsonl`, `candidates.jsonl`, `comparisons.jsonl`, `scores.jsonl`, `status.json`, `summary.json`, `artifacts/`); `prompts.ts` defines `general` and `paper-programming` prompt styles; `schemas.ts` is the Zod 4 source of truth for `RunConfig`, `Candidate`, `Comparison`, `Profile`, and the `ModelDriver` interface — and it is re-exported from `index.ts`, so it is public API (see *Zod 4* below).
- **`packages/providers`** — `ModelDriver` implementations. `fake.ts` (deterministic, no network), `openaiCompatible.ts` (covers DeepSeek, OpenRouter, custom OpenAI-compatible endpoints — driver falls back from JSON-mode to text + robust JSON extraction). `registry.ts` exposes `createDriver(ProviderConfig)` and a `RoleRoutingDriver` so per-role models (generator / mutator / judge / finalizer) can target different providers. `pricing.ts` + `defaults.ts` hold default USD pricing keyed by `(provider, model)`.
- **`packages/mcp`** — MCP server over the same core. `server.ts` registers tools (`deepthonk.plan|start|status|result|cancel|run|rank|mutate|resume|export`), resources (`deepthonk://runs/...` and `deepthonk://jobs/...`), and prompt templates. Stdio is default; Streamable HTTP available on `127.0.0.1:{port}/mcp`. Uses the stable `@modelcontextprotocol/sdk` (not the alpha split packages). MCP Sampling is available as a provider when running as an MCP server with a sampling-capable client. CLI standalone runs cannot use sampling — they need a direct provider.
- **`packages/cli`** — `commander`-based CLI. Each subcommand lives in `src/commands/*.ts` (`plan`, `run`, `inspect`, `resume`, `export`, `rank`, `mutate`, `setup`, `serveMcp`). `config.ts` loads/merges YAML from `~/.config/deepthonk/config.yaml` and exposes resolution helpers. CLI errors funnel through `--json-errors` for machine-readable stderr.

The CLI and MCP server are wrappers — keep algorithm logic in core. Do not duplicate the loop in either wrapper.

## Conventions specific to this codebase

- Never request hidden chain-of-thought. Ask models for final artifacts, concise rationales, critiques, and strict JSON where needed.
- API keys are never logged or written to trace files. Prompts and raw model outputs are off by default; only stored when `output.includePrompts` / `output.includeRawModelOutputs` is set.
- Errors extend `DeepThonkError` and carry a stable `{ code, message, retryable, fix }` shape — preserve this across CLI, MCP tool results, and trace events.
- Profile names `quick` / `balanced` / `paper` are built into `schemas.ts#builtInProfiles`. The `paper` profile selects the `paper-programming` prompt style automatically.
- Runtime budget caps (`maxCalls`, `maxInputTokens`, `maxOutputTokens`, `maxUsd`) are enforced *after* completed provider calls and can overshoot by up to one concurrency window. `maxUsd` requires known model pricing — add prices in YAML for custom providers/models.
- `runs/` is gitignored. Run directories are trace data, not source artifacts. Do not commit them.
- Conservative resume reports trace state and safe phase boundaries; it does not replay interrupted runs yet — do not invent partial replay.
- Streamable HTTP MCP transport (`packages/mcp/src/server.ts`) must keep `enableDnsRebindingProtection: true` and `allowedHosts` set to `127.0.0.1:<port>`/`localhost:<port>` (CVE-2025-66414 / GHSA-w48q-cv73-mx4w). Loopback bind alone is not enough — a browser DNS-rebinding attack bypasses it.
- Background `deepthonk.start` handlers in `packages/mcp/src/tools.ts` must wrap *both* the `.then` and `.catch` bodies in their own try/catch so a filesystem error (disk full, run dir gone) cannot escape as an unhandled rejection and tear down the server. The CLI also installs a process-level `unhandledRejection` guard in `packages/cli/src/index.ts`.
- Dry-run redaction (`packages/cli/src/commands/run.ts`) uses an anchored secret-key regex so env-var metadata fields (`apiKeyEnv`, `apiKeyFile`, `apiKeyStdin`) remain visible while actual secret-shaped keys are masked.

## Zod 4 (since v0.3.0)

`zod` is **part of `@deepthonk/core`'s published API** — `index.ts` does `export * from "./schemas.js"`, and zod is a runtime `dependencies` entry in all four published packages. A zod major bump changes the emitted `.d.ts` and the runtime `ZodError` class for anyone composing these schemas, so it is a **breaking release**, never a patch.

Traps that bit this repo during the v3 → v4 migration:

- **Enum-keyed records became exhaustive.** `z.record(z.enum([...]), v)` was *partial* in zod 3 and requires **every** key in zod 4. Use `z.partialRecord(z.enum([...]), v)` for optional-key maps like the `providers:` block in `packages/providers/src/externalConfig.ts`. This type-checks either way — the compiler will not save you; only tests will.
- `z.record(v)` no longer takes one argument. Always `z.record(z.string(), v)`.
- `z.ZodIssueCode.custom` is gone. Pass the string literal `code: "custom"` to `ctx.addIssue`.
- Default error text changed (`Too big: expected number to be <=1024`, not `Number must be less than or equal to 1024`) and `ZodError.message` serializes issues as JSON. It reaches MCP error strings via `formatZodIssues`. **Never assert on zod's exact wording in tests** — assert the bound and the semantics, or zod 5 breaks them again.
- Use zod 4's built-in `z.toJSONSchema`. `zod-to-json-schema` is removed; it does not support v4 schemas.
- `.strict()`, `.passthrough()`, `.datetime()`, `.url()`, and `superRefine` still work in 4.x but are deprecated and will be removed in zod 5.

## Dependency conventions

- **Anything `test/` imports must be declared in the root `package.json`.** `test/` lives at the workspace root, so a package that only reaches it transitively resolves fine locally and then fails CI with `ERR_MODULE_NOT_FOUND` under `pnpm install --frozen-lockfile`. This has happened three times (`yaml`, `@modelcontextprotocol/sdk`, `zod`). A clean-tree check catches it: `rm -rf node_modules packages/*/node_modules && pnpm install --frozen-lockfile && pnpm test`.
- `@deepthonk/core` depends only on `zod`. **Do not add `p-limit`** — it was removed in v0.3.0 because nothing imported it; `phaseRunner.ts` has its own worker pool.
- `@types/node` tracks the runtime floor (`^22`), not the newest release. `dependabot.yml` ignores its majors.
- `dependabot.yml` groups only minor/patch npm updates. Majors open individually and must be evaluated one at a time — a single grouped PR of five majors is unreviewable and permanently red.
- `packages/cli` declares `"engines": { "node": ">=22.13" }` because Commander 15 requires Node ≥ 22.12.

## Test conventions

- Never pass `os.tmpdir()` (or `join(runDir, "..")` where `runDir` came from `mkdtemp(tmpdir())`) as a runs-root. `listRunRecords` `readdir`s the runs-root, so it will enumerate every sibling temp dir any other test or prior run left behind, and `listRunResources` truncates at `MAX_LISTED_RESOURCES = 100`. Nest the run inside its own `mkdtemp` runs-root.
- A green suite on a clean `TMPDIR` proves little; CI always has one. Re-run against a dirty tmpdir before trusting an isolation fix.
- `pnpm test` appends to the repo's `runs/index.jsonl` because `recordRunResource` defaults `runsRoot` to `"runs"` relative to cwd. That is intended product behavior (it is how `deepthonk://runs` discovers runs stored elsewhere), not a bug to "fix" casually — changing it alters a published MCP surface.

## Acceptance check before claiming a change is done

```bash
pnpm install
pnpm run build
pnpm test
pnpm --silent --filter deepthonk deepthonk plan --profile paper
rm -rf runs/test-quick
pnpm --silent --filter deepthonk deepthonk run \
  --provider fake --profile quick \
  --task examples/tasks/toy-math.txt --out runs/test-quick
pnpm --silent --filter deepthonk deepthonk inspect runs/test-quick
```

## Release (tokenless OIDC)

CI (`.github/workflows/publish.yml`) publishes on a `v*` tag via **`pnpm publish`** (NOT `npm publish` — only pnpm rewrites the `workspace:*` internal deps), in topological order: `@deepthonk/core → @deepthonk/providers → @deepthonk/mcp → deepthonk`. Tokenless OIDC Trusted Publishing with provenance (pnpm 11 does the exchange natively, no npm CLI). Since v0.1.3. Since v0.2.1 the same workflow also publishes to the **MCP Registry** from `server.json`.

1. Bump **all four** `packages/*/package.json` to the SAME new version (root stays `private` at 0.1.0). npm rejects duplicates.
2. Bump `server.json` `version` **and** `packages[0].version` to that same version. A guard in `publish.yml` fails the release if they drift.
3. `pnpm install` (if deps changed) + `pnpm run build` + `pnpm test`.
4. Commit + push (PRs run `ci.yml` on Node 22/24).
5. `git tag vX.Y.Z && git push origin vX.Y.Z` → `publish.yml` runs both guards, publishes the four to npm in order, cuts the GitHub release, then publishes to the MCP Registry.

**MCP Registry (since v0.2.1).** `server.json` declares `io.github.linxule/deepthonk`, referencing the published **`deepthonk`** CLI package — not the private `deepthonk-monorepo` root, and not `@deepthonk/mcp`, which ships no `bin`. The registry proves npm ownership by reading **`mcpName` from the published `packages/cli/package.json`**, which must exactly equal `server.json` `name`. npm versions are immutable, so **`mcpName` can never be backfilled into an already-published version** — a release that forgets it needs a new version. The `deepthonk` bin has no default action, so `server.json` passes `serve-mcp` as a positional `packageArguments` entry; without it clients would spawn a help page instead of a server. No API key is required (MCP Sampling and the `fake` provider need none), so every `environmentVariables` entry is `isRequired: false`. Registry publish runs **last**, after the GitHub release, so a failure there is recoverable with a bare `mcp-publisher publish` — never a re-run of the npm steps, which would die on `EPUBLISHCONFLICT`. Validate locally with `mcp-publisher validate`. Auth in CI is `mcp-publisher login github-oidc` (no secret; needs `id-token: write`).

**One-time (done 2026-06-22):** a Trusted Publisher on **each of the 4 packages** — the scoped three live under the `@deepthonk` npm **org**, not your personal package list. Per package: owner `linxule`, repo `deepthonk`, workflow `publish.yml`, Environment blank, allow publish. CLI: `npm trust github <pkg> --repo linxule/deepthonk --file publish.yml --allow-publish --yes` (npm ≥ 11.5.1; 2FA required each call).

**pnpm-11 publish gotchas (this repo hit all of them):** pin pnpm via `packageManager`, not action-setup's `version:` (it errors on mismatch); `allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml` (pnpm 11 errors on ignored build scripts); no `postpack` rm of README/LICENSE (pnpm 11's native publish stats `files` *after* postpack → `ENOENT` — `prepack` copies persist instead, gitignored).
