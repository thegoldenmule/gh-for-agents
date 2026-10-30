# gh-for-agents

`ghx` is a CLI that coding agents such as Claude Code call instead of the GitHub
CLI. It wraps `gh`, which still handles auth and HTTP. Writes go through strict
validation, and each common question takes one plain call that returns JSON.
Callers don't need pipes, `--jq`, `sleep` or `timeout`.

## What it does

These are the v1 commands, specified in [02-api](docs/plans/02-api.md).

| | What it does |
| --- | --- |
| `pr create` | Opens a PR from validated JSON and renders a short body. `--example` prints a valid input for the repo; `--batch` opens several. |
| `pr edit` | Patches a PR's structured fields and re-renders the body, with the same validation. |
| `pr ready` | Marks any PR ready for review, or back to draft with `--undo`. |
| `pr status` | Returns one object: description, metadata, merge state, CI for the head SHA, feedback and blockers. Several PRs (`pr status 12 13 14`) return `{results: […]}`. |
| `pr feedback` | Merges feedback from all three GitHub sources into one list, with bots kept separate. |
| `pr comment`, `pr review` | Post structured comments and reviews. |
| `pr resolve` | Records a status on feedback items, such as addressed or wontfix. |
| `pr merge` | Merges according to the repo's policy, with the head SHA pinned. Overrides need a reason. |
| `pr land` | Waits until the PR is mergeable, then merges it pinned to that head. Never merges on red CI. |
| `ci why` | Diagnoses a failing run in one call, including runs still in progress. Takes a PR, `run:<id>`, or `branch:main` for every failing workflow on main's head. |
| `ci wait` | Waits for CI to finish, then prints one JSON summary. The caller never sets a duration. Takes PRs, `branch:<name>[@sha]` or `run:<id>`. |
| `ci rerun`, `ci retrigger` | Rerun failed jobs (of a PR's head or of `run:<id>`), or trigger CI again. |
| `doctor` | Checks the setup: `gh` version and features, auth, git, the target repo and its config. |
| `init` | Writes a starter `.github/ghx.json`, with components inferred from the workspace. |
| `version` | Prints the `ghx` version, Node version and platform, with no `gh` calls. |
| `help`, `schema` | JSON help, and the JSON Schema of any command's input and output or of the config. |
| `hook claude-pretooluse` | The Claude Code PreToolUse hook: places `ghx ci wait` and `ghx pr land` (background in the main thread, foreground in a subagent) and steers raw `gh` to `ghx`. |

A `gh`-shaped read typed through `ghx` runs its `ghx` equivalent, with a
`REDIRECTED` warning naming the command for next time: `ghx pr view 12` runs
`ghx pr status 12`, and `ghx run view 99 --log-failed` runs `ghx ci why run:99`.
`gh` writes that `ghx` wraps are refused, and the error names the `ghx` command
to use instead. A short list of read-only `gh` commands still runs, with its
output wrapped in JSON.

Every JSON command takes `--fields a.b,c.d` to keep only the parts the agent
needs (a path through an array maps over it, so `ci.failing.name` needs no
`[]`), and `--brief` for the fields agents usually extract. Errors are never
trimmed. This replaces the `| jq` and `| head -c` that agents otherwise add.

## Example

The agent starts from `ghx pr create --example`, which prints a valid input
with the repo's component names and the rules, edits it, and writes the PR as
data (`ghx pr create --input pr.json`):

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
  "refs": {"closes": ["#2894"]}
}
```

`ghx` checks the title format and length, the description length, and that
each test can be re-run, and reports every issue in one pass before it writes
anything, so there is no need for a dry run first. `base` and `head` default to
the default and current branch. It checks the components against
`.github/ghx.json` and adds the ones the diff touches; a PR that touches more
than 5 lists its 5 primary components, and `ghx` records the rest in the hidden
block (`alsoTouched`), shown as `Components: a, b, c, d, e (+21 more)`. Mechanical
slips are fixed with a warning instead of a rejection: a `body` field becomes
`description` (`FIELD_RENAMED`), a trailing period leaves the title
(`TITLE_PERIOD_REMOVED`), an old component name maps through the config's
`aliases` (`COMPONENT_ALIAS`), and a Claude Code footer appended to
`description` is stripped (`FOOTER_STRIPPED`), since `ghx` renders its own. It
then renders a short body:

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
outcome. A subagent can't be woken by a background task, so it waits in the
foreground with `--foreground`, which returns within 9 minutes (exit 15 if CI
hasn't settled; it re-runs the identical command, which resumes). A second wait
on the same PR follows the first instead of polling again. `ghx pr land <pr>`
waits until the PR is mergeable and then merges it.

## Status

Every v1 command exists, along with passthrough for read-only `gh` commands.
Agent acceptance hasn't run yet: it means scoring the Claude Code sessions of
three real PRs worked on with `ghx` (`scripts/acceptance/score.ts`). Multi-PR
`pr status`, `--fields`/`--brief` and the `run:<id>` and `branch:` CI targets
came from reading how agents used `ghx` in its first week on a real monorepo. The build
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
blocks raw `gh` writes and denies wrapped `gh` reads, naming the `ghx`
replacement so the agent runs it without stopping (`GHX_HOOK_MODE=ask` turns that
into a permission prompt). It does this only in repos that have
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

`GHX_HOOK_LOG=<path>` and `GHX_LOG=<path>` turn on two local NDJSON logs, of what
the hook decided and of each ghx call with the gh calls behind it, for measuring
ghx against raw gh. Both are off by default and write only to the file you name.
See [docs/agents/hooks.md](docs/agents/hooks.md#logs-for-evaluation-opt-in).

This repo's own config is [.github/ghx.json](.github/ghx.json).

## Design docs

- [Research: how agents use `gh`](docs/research/gh-usage-findings.md)
- [00 Brief](docs/plans/00-brief.md). Its decision sections at the end override the body.
- [01 Scaffolding](docs/plans/01-scaffolding.md)
- [02 API](docs/plans/02-api.md)
- [03 Implementation and testing](docs/plans/03-implementation.md)
- [04 Build coordination](docs/plans/04-build-coordination.md)
- [05 Build handoff](docs/plans/05-handoff.md)
