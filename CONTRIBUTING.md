# Contributing

Thanks for considering a contribution to DeepThonk.

## Development

Requires Node ≥ 22.13 (pnpm 11's floor; the published CLI declares the same in `engines`).

```bash
pnpm install
pnpm run build
pnpm test
pnpm run lint        # typecheck across all workspace packages
```

### If you add or remove a dependency

`test/` lives at the workspace root, so anything it imports must be declared in the **root** `package.json`. A package that only reaches it transitively resolves fine against a warm `node_modules` and then fails CI with `ERR_MODULE_NOT_FOUND`. Reproduce CI's resolution before pushing:

```bash
rm -rf node_modules packages/*/node_modules
pnpm install --frozen-lockfile
pnpm test
```

## Acceptance smoke before opening a PR

Run the same fake-provider smoke that ships with the repo:

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

## Project layout

Four workspace packages (`packages/{core,providers,mcp,cli}`). The algorithm engine lives in `packages/core`. The CLI and MCP server are wrappers — keep loop and budget logic in core, not in either wrapper. See `CLAUDE.md` and `AGENTS.md` for the build contract.

## What to avoid

- Requesting hidden chain-of-thought from models (the prompts deliberately forbid it).
- Logging API keys or env-var values.
- Writing prompts or raw model outputs to trace files unless `output.includePrompts` / `output.includeRawModelOutputs` is set.
- Duplicating algorithm logic between CLI and MCP — both should call `runDeepThonk` from `@deepthonk/core`.

## Reporting issues

Open an issue at <https://github.com/linxule/deepthonk/issues>. For security issues, see `SECURITY.md`.
