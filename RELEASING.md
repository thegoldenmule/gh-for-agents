# Releasing

`@thegoldenmule/ghx` is published to npm by `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow uses npm trusted publishing: GitHub's OIDC token proves the publish comes from this repository's `release.yml`, so there is no npm token stored anywhere, and npm attaches provenance to each version.

npm can link a trusted publisher only to a package that already exists. So the first version is published by hand, once.

## One-time setup

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

## Each release

1. Bump the version in `package.json` (this also makes the commit):

   ```sh
   npm version patch   # or minor / major; commits "x.y.z" and tags vx.y.z
   ```

   To do it by hand instead, edit `version`, commit, and run `git tag v<version>`. The tag must be exactly `v` plus the `package.json` version, or the workflow stops before publishing.

2. Push the commit and the tag:

   ```sh
   git push origin main
   git push origin v<version>
   ```

3. Watch the `release` workflow. It checks that the tag matches `package.json`, makes sure npm is at least 11.5.1 (needed for trusted publishing), runs `pnpm check`, `pnpm docs:check` and `pnpm pack:test`, then runs `npm publish`.

Users upgrade with `npm update -g @thegoldenmule/ghx`. The hook runs the global copy by path, so it picks up the new version. `ghx doctor` warns `INSTALL_HOOK_VERSION_MISMATCH` or `INSTALL_HOOK_NODE_MISMATCH` when the hook runs another copy or another node, and rerunning `ghx install` fixes it.
