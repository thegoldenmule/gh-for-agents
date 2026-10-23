# gh-for-agents

`ghx` is a CLI that coding agents such as Claude Code call instead of the GitHub
CLI. It wraps `gh`, which still handles auth and HTTP. Writes go through strict
validation, and each common question takes one plain call that returns JSON.
Callers don't need pipes, `--jq`, `sleep` or `timeout`.

## Why

Thirty days of agent transcripts (1,676 commands, 2,661 `gh` invocations)
showed that real `gh` errors are rare. The cost is in call volume and the glue
around it.

- 55% of all `gh` invocations babysit CI. Finding out why CI failed takes a
  median of 6 calls.
- Agents improvised their own polling: 232 commands with `sleep`/`until`/`while`,
  and 44 hand-written Monitor scripts.
- The user corrected PR bodies twice to "2–3 sentences, no sections, no test
  logs". The median body went from 2,406 characters to 568.
- Only 8 of 52 merges pinned the head commit.

## What it does

These are the v1 commands, specified in [02-api](docs/plans/02-api.md).

| | What it does |
| --- | --- |
| `pr create` | Opens a PR from validated JSON and renders a short body. `--batch` opens several. |
| `pr edit` | Patches a PR's structured fields and re-renders the body, with the same validation. |
| `pr status` | Returns one object: description, metadata, merge state, CI for the head SHA, feedback and blockers. |
| `pr feedback` | Merges feedback from all three GitHub sources into one list, with bots kept separate. |
| `pr comment`, `pr review` | Post structured comments and reviews. |
| `pr resolve` | Records a status on feedback items, such as addressed or wontfix. |
| `pr merge` | Merges according to the repo's policy, with the head SHA pinned. Overrides need a reason. |
| `ci why` | Diagnoses a failing run in one call, including runs still in progress. |
| `ci wait` | Waits for CI to finish, then prints one JSON summary. The caller never sets a duration. |
| `ci rerun`, `ci retrigger` | Rerun failed jobs, or trigger CI again. |
| `doctor` | Checks the setup: `gh` version and features, auth, git, the target repo and its config. |
| `init` | Writes a starter `.github/ghx.json`, with components inferred from the workspace. |
| `version` | Prints the `ghx` version, Node version and platform, with no `gh` calls. |
| `help`, `schema` | JSON help, and the JSON Schema of any command's input and output or of the config. |
| `hook claude-pretooluse` | The Claude Code PreToolUse hook: runs `ghx ci wait` in the background and steers raw `gh` to `ghx`. |

Raw `gh` commands that `ghx` wraps are refused, and the error names the `ghx`
command to use instead. A short list of read-only `gh` commands still runs, with
its output wrapped in JSON.

## Example

The agent writes the PR as data (`ghx pr create --input pr.json`):

```json
{
  "title": "fix(reactor): bind documentId when signing actions on the write path",
  "description": "The primary write path signed actions without binding documentId.\nsignAction now always binds it, and verify rejects unbound candidates.",
  "testing": [
    {"kind": "unit", "command": "pnpm --filter @powerhousedao/reactor test -- signature", "result": "pass"},
    {"kind": "typecheck", "command": "pnpm tsc -b", "result": "pass"}
  ],
  "risk": "medium",
  "riskNote": "Clients that sign without a documentId now get a verification error.",
  "components": ["reactor", "shared"],
  "revertPolicy": "revert-safe",
  "base": "main",
  "head": "fix/reactor-bind-document-id",
  "refs": {"closes": ["#2894"]}
}
```

`ghx` checks the title format and length, the description length, and that
each test can be re-run. It checks the components against `.github/ghx.json`.
It then renders a short body:

```markdown
The primary write path signed actions without binding documentId.
signAction now always binds it, and verify rejects unbound candidates.

Risk: medium · Components: reactor, shared · Revert: revert-safe · Tests: 2/2 pass (unit, typecheck) · Closes #2894

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {...the full input as JSON...} -->
```

GitHub doesn't show the hidden block, but `pr status` reads it back.

Waiting for CI works the same way every time. The agent runs `ghx ci wait <pr>`
in the background and moves on. It is woken once, when CI finishes or stalls.
The JSON summary includes the failure diagnosis, and the exit code gives the
outcome.

## Status

Every v1 command exists, along with passthrough for read-only `gh` commands.
Agent acceptance hasn't run yet: it means scoring the Claude Code sessions of
three real PRs worked on with `ghx` (`scripts/acceptance/score.ts`). The build
order is in [04-build-coordination](docs/plans/04-build-coordination.md).

## Install

You need Node.js 24 or later and `gh` 2.81.0 or later, logged in
(`gh auth login`). Install `ghx` and set up Claude Code in one step:

```sh
npx @thegoldenmule/ghx install
```

Run from `npx`, `ghx install` first installs the same version globally
(`npm i -g @thegoldenmule/ghx@<version>`) and hands the install to that copy,
so the hook never points into npm's cache. To do it in two steps instead:

```sh
npm i -g @thegoldenmule/ghx
ghx install --dry-run   # shows the diffs; writes nothing
ghx install
ghx doctor
ghx init                # in the repo you work on: writes .github/ghx.json
```

If `npm i -g` fails with `EACCES`, your global npm prefix belongs to root: use
a Node.js you own (nvm or fnm) rather than `sudo`.

`ghx install` adds the PreToolUse hook to `~/.claude/settings.json` and the
CLAUDE.md snippet to `~/.claude/CLAUDE.md`. Enforcement is per repo: the hook
blocks raw `gh` writes and suggests `ghx` reads only in repos that have
`.github/ghx.json`, and stays silent elsewhere. It keeps your other settings and
backs up each file it changes. It's safe to run again, and `ghx uninstall`
removes only what it added. Use `--scope project` to install into a repo's
`.claude/settings.local.json` (per machine, not committed) instead; that scope
also adds `permissions.deny` rules for raw `gh` writes. User scope doesn't,
because deny rules can't be conditional: they would block `gh` in every repo,
configured or not. [docs/agents/hooks.md](docs/agents/hooks.md) describes what
it writes. The [docs/agents](docs/agents/) folder also has the skill and the
command reference.

Upgrade with `npm update -g @thegoldenmule/ghx`; the hook runs the global copy,
so it picks up the new version (`ghx doctor` warns if the hook runs another
copy or another `node`; run `ghx install` again). Uninstall with:

```sh
ghx uninstall && npm rm -g @thegoldenmule/ghx
```

### Developing

Clone the repo, run `pnpm install`, and run `node bin/ghx.js` (it runs
`src/` directly; there is no build step in a checkout).
`node bin/ghx.js install --bin-dir ~/.local/bin` points the hook at the checkout
and links `ghx` onto your `PATH`. `pnpm check` runs typecheck, lint and tests;
`pnpm pack:test` packs and installs the package into a temp prefix. Releases:
[RELEASING.md](RELEASING.md).

This repo's own config is [.github/ghx.json](.github/ghx.json).

## Design docs

- [Research: how agents use `gh`](docs/research/gh-usage-findings.md)
- [00 Brief](docs/plans/00-brief.md). Its decision sections at the end override the body.
- [01 Scaffolding](docs/plans/01-scaffolding.md)
- [02 API](docs/plans/02-api.md)
- [03 Implementation and testing](docs/plans/03-implementation.md)
- [04 Build coordination](docs/plans/04-build-coordination.md)
- [05 Build handoff](docs/plans/05-handoff.md)
