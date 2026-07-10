# Release and Publishing

DeepThonk publishes four npm packages from this workspace:

- `@deepthonk/core`
- `@deepthonk/providers`
- `@deepthonk/mcp`
- `deepthonk`

Publishing is tag-triggered by `.github/workflows/publish.yml`. The workflow uses npm Trusted Publishing through GitHub Actions OIDC, so it must not use `NPM_TOKEN`.

Since v0.2.1 the same workflow also publishes the server to the [MCP Registry](https://modelcontextprotocol.io/registry) as `io.github.linxule/deepthonk`, from the root `server.json`. That step also authenticates with GitHub Actions OIDC (`mcp-publisher login github-oidc`) and needs no secret.

## How the MCP Registry Entry Works

- `server.json` references the published **`deepthonk`** CLI package. It cannot reference `deepthonk-monorepo` (private, never published) or `@deepthonk/mcp` (ships no `bin`).
- The `deepthonk` bin has **no default action**, so `server.json` passes `serve-mcp` as a positional `packageArguments` entry. Without it, a client would spawn `npx deepthonk`, which prints help instead of speaking MCP.
- The registry verifies npm ownership by reading **`mcpName` from the published `packages/cli/package.json`**. It must exactly equal `server.json`'s `name`.
- **npm versions are immutable, so `mcpName` cannot be added to a version that is already published.** If a release ships without it, the fix is a new version — this is precisely why v0.2.1 exists.
- No API key is required to run the server (MCP Sampling and the `fake` provider need none), so every `environmentVariables` entry is `isRequired: false`.

Validate the file locally before tagging:

```bash
mcp-publisher validate
```

## One-Time npm Setup

Each package needs its own npm Trusted Publisher configuration:

1. Open the package settings on npmjs.com for each of the four packages.
2. Add a Trusted Publisher for GitHub Actions.
3. Use:
   - Owner: `linxule`
   - Repository: `deepthonk`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
   - Environment: blank, unless the workflow is later changed to use one
4. Keep the workflow on GitHub-hosted runners.

The workflow already grants `id-token: write` and uses Node 22 with `pnpm@11.8.0`. npm's current Trusted Publishing docs require a recent Node/npm toolchain and OIDC support; do not downgrade the workflow.

Reference: https://docs.npmjs.com/trusted-publishers/

## Per-Release Checklist

1. Confirm the latest published versions:

   ```bash
   npm view @deepthonk/core version
   npm view @deepthonk/providers version
   npm view @deepthonk/mcp version
   npm view deepthonk version
   ```

2. Choose the next unused version. All four published packages must use the same version; never reuse a partially published version.

3. Update exactly these manifests:

   ```text
   packages/core/package.json
   packages/providers/package.json
   packages/mcp/package.json
   packages/cli/package.json
   server.json                  # version AND packages[0].version
   ```

   The root `package.json` is private and does not gate publish. Internal dependencies stay as `workspace:*`; `pnpm publish` rewrites those to concrete versions when packing. Never remove `mcpName` from `packages/cli/package.json`.

4. Run the local release checks:

   ```bash
   pnpm install
   pnpm run build
   pnpm run typecheck
   pnpm test
   pnpm audit --prod --audit-level high
   pnpm run bench:ci
   mcp-publisher validate
   pnpm --silent --filter deepthonk deepthonk plan --profile paper
   rm -rf runs/test-quick
   pnpm --silent --filter deepthonk deepthonk run --provider fake --profile quick --task examples/tasks/toy-math.txt --out runs/test-quick
   pnpm --silent --filter deepthonk deepthonk inspect runs/test-quick
   ```

5. Commit the code and version bump:

   ```bash
   git add README.md docs packages test .github server.json CHANGELOG.md
   git commit -m "release: prepare vX.Y.Z"
   git push origin main
   ```

6. Tag the exact commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

7. Watch the `Publish` GitHub Actions run. The workflow verifies build/typecheck/tests, production audit, and performance budgets; checks that every package version matches the tag; checks `server.json` against the tag, the CLI package name, and `mcpName`; publishes in dependency order; creates the GitHub release; then publishes to the MCP Registry:

   ```text
   @deepthonk/core -> @deepthonk/providers -> @deepthonk/mcp -> deepthonk -> MCP Registry
   ```

   The registry step runs last on purpose. npm versions are immutable, so a failure there must be recoverable without re-running the npm steps.

8. Verify npm after the workflow finishes:

   ```bash
   npm view @deepthonk/core version
   npm view @deepthonk/providers version
   npm view @deepthonk/mcp version
   npm view deepthonk version
   npm view deepthonk dist-tags
   npm install -g deepthonk@X.Y.Z
   deepthonk --version
   deepthonk plan --profile paper
   npm uninstall -g deepthonk
   ```

## Failure Handling

- If the workflow fails before publish, fix the issue, commit, delete the failed local tag if needed, recreate it on the fixed commit, and push the tag again.
- If one package publishes and a later package fails, do not reuse the same version for the already-published package. Fix forward with a new version for all four packages.
- If npm returns an auth-like `404`, verify the Trusted Publisher settings exactly match owner `linxule`, repo `deepthonk`, and workflow file `publish.yml` for the package that failed.
- Do not manually publish with `npm publish` from this workspace. This repo relies on `pnpm publish` so `workspace:*` dependencies are rewritten correctly.
- If only the **MCP Registry** step fails, npm and the GitHub release are already done. Do **not** re-run the workflow — the npm steps would fail with `EPUBLISHCONFLICT`. Recover from a clean clone of the tag:

  ```bash
  git checkout vX.Y.Z
  mcp-publisher validate
  mcp-publisher login github
  mcp-publisher publish
  ```

- If the registry reports `Package validation failed`, the published `deepthonk` manifest is missing a matching `mcpName`. Confirm with `npm view deepthonk@X.Y.Z mcpName`. It cannot be patched in place; ship a new version.
