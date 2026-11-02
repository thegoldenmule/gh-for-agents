# Releasing

A `v*` tag runs `.github/workflows/release.yml`, which publishes a GitHub release with standalone `ghx` binaries and, once npm is set up, publishes `@thegoldenmule/ghx` to npm.

## What a release contains

| Asset | What it is |
| --- | --- |
| `ghx-darwin-arm64.tar.gz`, `ghx-darwin-x64.tar.gz`, `ghx-linux-arm64.tar.gz`, `ghx-linux-x64.tar.gz` | One executable, `ghx`, at the archive root: a Bun `--compile` build with its own runtime. There is no Windows binary. |
| `ghx.tgz` | The `npm pack` tarball, for Node.js 24 or later and Windows: `npm i -g https://github.com/thegoldenmule/gh-for-agents/releases/latest/download/ghx.tgz`. The name has no version so that URL stays stable. |
| `install.sh` | The installer behind `curl -fsSL …/releases/latest/download/install.sh \| sh`. |
| `SHA256SUMS` | `sha256sum` lines for every other asset. `install.sh` checks the archive against it. |

Every asset has a build provenance attestation: `gh attestation verify <asset> --repo thegoldenmule/gh-for-agents`.

The release is never a pre-release, because `releases/latest/download/…`, which the one-liner and the docs use, ignores pre-releases.

## Each release

1. Bump the version in `package.json` (this also makes the commit and the tag):

   ```sh
   npm version patch   # or minor / major; commits "x.y.z" and tags vx.y.z
   ```

   To do it by hand instead, edit `version`, commit, and run `git tag v<version>`. The tag must be exactly `v` plus the `package.json` version, or the workflow stops before building.

2. Optionally, write the release notes to `docs/release-notes/v<version>.md` and commit them before tagging. When that file exists, the release uses it; otherwise GitHub generates notes from the merged PRs and commits.

3. Optionally, dry-run the workflow first: run `release` from the Actions tab (or `gh workflow run release.yml`). On `workflow_dispatch` it does everything except publish: it checks, builds, tests, and uploads the assets as the `release-assets` workflow artifact.

4. Push the commit and the tag:

   ```sh
   git push origin main
   git push origin v<version>
   ```

5. Watch the `release` workflow. Its jobs:
   - **check**: the tag matches `package.json`; `pnpm check`, `pnpm docs:check` and `pnpm pack:test`.
   - **build**: installs a pinned Bun, cross-compiles all four binaries with `pnpm build:bin --target all` (and a `--test-hooks` set for the contract suite), packs `ghx.tgz`, and writes the archives, `install.sh` and `SHA256SUMS`.
   - **test**: on a native runner per target (`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`), `install.sh` installs the archive from the built assets, macOS checks the code signature, and the contract suite (`GHX_TEST_BIN=… pnpm test:contract`) and the smoke test (`pnpm bin:test`) run against the binary.
   - **release**: attests the assets, creates the release as a draft with them, then publishes it and marks it latest. A re-run that finds its own draft replaces the draft's assets; a release that is already published stops it.
   - **verify-install**: runs the published one-liner on Linux and macOS with `GHX_VERSION=<tag>` and checks that `ghx --version` reports the tag.
   - **npm**: publishes to npm, only when the `NPM_PUBLISH` repository variable is `true` (see below) and the binary tests passed.

Binary users upgrade by running the one-liner again; it replaces `~/.local/bin/ghx` in place, so the hook keeps working. npm users upgrade with `npm update -g @thegoldenmule/ghx`; the hook runs the global copy by path, so it picks up the new version. `ghx doctor` warns `INSTALL_HOOK_VERSION_MISMATCH` or `INSTALL_HOOK_NODE_MISMATCH` when the hook runs another copy or another node, and rerunning `ghx install` fixes it.

## npm publishing (one-time setup)

The `npm` job uses npm trusted publishing: GitHub's OIDC token proves the publish comes from this repository's `release.yml`, so there is no npm token stored anywhere, and npm attaches provenance to each version. npm can link a trusted publisher only to a package that already exists, so the first version is published by hand, once. Until then the `npm` job is skipped, and releases ship only the GitHub assets.

1. Log in to npm as the package owner, and check the account:

   ```sh
   npm login
   npm whoami   # must print: thegoldenmule
   ```

2. Publish the first version from a clean checkout of `main`, at the version in `package.json`:

   ```sh
   git clone https://github.com/thegoldenmule/gh-for-agents.git ghx-release
   cd ghx-release
   pnpm install --frozen-lockfile
   pnpm check
   pnpm pack:test
   npm publish --access public --provenance=false
   ```

   `prepublishOnly` rebuilds `dist/` first. `--provenance=false` is needed only here: `publishConfig` asks for provenance, which npm can generate only inside CI, and a flag on the command line overrides `publishConfig`.

3. On npmjs.com, open the package's **Settings**, find **Trusted publishing**, and add a GitHub Actions trusted publisher:
   - Organization or user: `thegoldenmule`
   - Repository: `gh-for-agents`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   Optionally, under **Publishing access**, also require two-factor authentication and disallow tokens, so only the workflow can publish.

4. Turn the `npm` job on:

   ```sh
   gh variable set NPM_PUBLISH --body true --repo thegoldenmule/gh-for-agents
   ```

   From the next tag on, the workflow checks that npm is at least 11.5.1 (needed for trusted publishing) and runs `npm publish`.
