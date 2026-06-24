# Release and Publishing

DeepThonk publishes four npm packages from this workspace:

- `@deepthonk/core`
- `@deepthonk/providers`
- `@deepthonk/mcp`
- `deepthonk`

Publishing is tag-triggered by `.github/workflows/publish.yml`. The workflow uses npm Trusted Publishing through GitHub Actions OIDC, so it must not use `NPM_TOKEN`.

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

2. Choose the next unused version. All four published packages must use the same version. If npm currently shows `0.1.3`, use `0.1.4` for the next patch release.

3. Update exactly these manifests:

   ```text
   packages/core/package.json
   packages/providers/package.json
   packages/mcp/package.json
   packages/cli/package.json
   ```

   The root `package.json` is private and does not gate publish. Internal dependencies stay as `workspace:*`; `pnpm publish` rewrites those to concrete versions when packing.

4. Run the local release checks:

   ```bash
   pnpm install
   pnpm run build
   pnpm run typecheck
   pnpm test
   pnpm --silent --filter deepthonk deepthonk plan --profile paper
   rm -rf runs/test-quick
   pnpm --silent --filter deepthonk deepthonk run --provider fake --profile quick --task examples/tasks/toy-math.txt --out runs/test-quick
   pnpm --silent --filter deepthonk deepthonk inspect runs/test-quick
   ```

5. Commit the code and version bump:

   ```bash
   git add README.md docs packages test .github
   git commit -m "release: prepare vX.Y.Z"
   git push origin main
   ```

6. Tag the exact commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

7. Watch the `Publish` GitHub Actions run. The workflow verifies build/typecheck/tests, checks that every package version matches the tag, then publishes in dependency order:

   ```text
   @deepthonk/core -> @deepthonk/providers -> @deepthonk/mcp -> deepthonk
   ```

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
