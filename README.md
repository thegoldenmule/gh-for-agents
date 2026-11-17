# gh-for-agents

`ghx` is a CLI that coding agents such as Claude Code call instead of the GitHub
CLI. It wraps `gh`, which still handles auth and HTTP. Writes go through strict
validation, and each common question takes one plain call that returns JSON.
Callers don't need pipes, `--jq`, `sleep` or `timeout`.

## Install

You need `gh` 2.81.0 or later, logged in (`gh auth login`). On macOS or Linux,
install the `ghx` binary into `~/.local/bin` and set up Claude Code:

```sh
curl -fsSL https://github.com/thegoldenmule/gh-for-agents/releases/latest/download/install.sh | sh
ghx install
```

The script picks the archive for your OS and CPU, checks it against the
release's `SHA256SUMS`, and needs no `sudo`. `GHX_VERSION=v0.1.0` pins a
release and `GHX_INSTALL_DIR` picks another directory. If `~/.local/bin` isn't
on your `PATH`, it prints the line to add. `ghx install --dry-run` shows the
diffs `ghx install` would make and writes nothing; `ghx doctor` checks the
setup; and `ghx init`, run in the repo you work on, writes `.github/ghx.json`.

To download by hand instead, take `ghx-<os>-<arch>.tar.gz` for your machine
from the [Releases page](https://github.com/thegoldenmule/gh-for-agents/releases),
run `tar xzf` on it, and move `ghx` into a directory on your `PATH`. A file a
browser downloaded on macOS is quarantined: clear it with
`xattr -d com.apple.quarantine ghx`, or allow it under System Settings →
Privacy & Security → Open Anyway. Each release is attested:
`gh attestation verify ghx-<os>-<arch>.tar.gz --repo thegoldenmule/gh-for-agents`.

To upgrade, run the one-liner again. The path stays the same, so the hook
keeps working. Uninstall with:

```sh
ghx uninstall && rm ~/.local/bin/ghx
```

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

### With npm (Node.js 24 or later, and Windows)

There is no Windows binary. On Windows, or to run `ghx` on your own Node.js,
install the npm package from the release:

```sh
npm i -g https://github.com/thegoldenmule/gh-for-agents/releases/latest/download/ghx.tgz
ghx install
```

Once `@thegoldenmule/ghx` is on the npm registry, `npm i -g @thegoldenmule/ghx`
works too, as does `npx @thegoldenmule/ghx install`, which installs the same
version globally first so the hook never points into npm's cache. If
`npm i -g` fails with `EACCES`, your global npm prefix belongs to root: use a
Node.js you own (nvm or fnm) rather than `sudo`. Upgrade by installing again
(`ghx doctor` warns if the hook runs another copy, another `node`, or the
standalone binary; run `ghx install` again), and uninstall with
`ghx uninstall && npm rm -g @thegoldenmule/ghx`.

## What it does

These are the v1 commands, specified in [02-api](docs/plans/02-api.md).

| | What it does |
| --- | --- |
| `pr create` | Opens a PR from validated JSON and renders a short body. `--example` prints a valid input for the repo; `--batch` opens several. |
| `pr edit` | Patches a PR's structured fields and re-renders the body, with the same validation. |
| `pr ready` | Marks any PR ready for review, or back to draft with `--undo`. |
| `pr status` | Returns one object: description, metadata, merge state, CI for the head SHA, feedback and blockers. Several PRs (`pr status 12 13 14`) return `{results: […]}`. |
| `pr impact` | Derives components, overflow and the risk floor from changed paths for open or historical PRs, including PRs without a ghx block. Takes several PRs in one call. |
| `pr check` | Validates stored PR metadata and visible text against config at the target SHA. `--merge-policy` also evaluates repository merge gates for CI. |
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
then renders a short body with brief sections:

```markdown
## Summary

The primary write path signed actions without binding documentId.
signAction now always binds it, and verify rejects unbound candidates.

Risk: medium · Components: reactor, shared · Revert: revert-safe · Tests: 2/2 pass (unit, typecheck) · Closes #2894

## Data

- ticket: `ENG-2894`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {...the full input as JSON...} -->
```

GitHub doesn't show the hidden block, but `pr status` reads it back.

An agent can attach its own facts in `data` (`{"ticket": "ENG-2894"}`): they are
listed under Data and come back from `pr status` as `meta.data`. A project can
require fields in `.github/ghx.json` (`data.fields`, typed, required always or
from a risk up); an agent can always add more keys than the project requires,
never fewer. A project can also replace the layout with its own template,
`render.prBody`, using placeholders such as `{{description}}`, `{{trailer}}`,
`{{data}}` and `{{data.ticket}}` ([plan 08](docs/plans/08-templates-and-data.md)).

Waiting for CI works the same way every time. The agent runs `ghx ci wait <pr>`
in the background and moves on. It is woken once, when CI finishes or stalls.
The JSON summary includes the failure diagnosis, and the exit code gives the
outcome. A subagent can't be woken by a background task, so it waits in the
foreground with `--foreground`, which returns within 9 minutes (exit 15 if CI
hasn't settled; it re-runs the identical command, which resumes). A second wait
on the same PR follows the first instead of polling again. `ghx pr land <pr>`
waits until the PR is mergeable and then merges it.

### Ticket titles and defect references

Repositories using tracker keys can select ticket titles in `.github/ghx.json`:

```json
{"title":{"format":"ticket","ticket":{"pattern":"^ENG-\\d+$","example":"ENG-123"}}}
```

This requires titles such as `ENG-123: retry the request`; the default remains
`type(scope): summary`. The example must match the complete key pattern and is
used by `pr create --example`. Ticket keys do not automatically fill `data`, and
`ghx init` does not infer ticket patterns.

To record which earlier PR introduced a defect, use
`"refs":{"fixes":["#123","other/repo#456"]}`. Targets must be PRs. The trailer
says `Repairs defects from #123`, which does not trigger GitHub issue closing.
Use `refs.closes` for issues that should close on merge.

### Review sources and external evidence

A finding can identify its reviewer or check with `source`, using the same token
rules as a data key. It can also quote evidence from a ticket or decision record:

```json
{
  "verdict": "request-changes",
  "summary": "The retry behavior misses an acceptance criterion.",
  "findings": [{
    "severity": "medium",
    "source": "ticketAcceptance",
    "title": "Retry stops too early",
    "body": "The implementation stops after the first transient failure.",
    "evidence": {
      "source": "ENG-123 acceptance criteria",
      "quote": "Retry a transient failure three times.",
      "url": "https://tracker.example/ENG-123"
    }
  }]
}
```

Pass this to `ghx pr review <pr> --input review.json`. Without `path` and `line`,
the finding appears in the review body with its own ID and can be resolved with
`pr resolve`. Located findings may also carry evidence. `source` and `evidence`
come back through `pr feedback` and `pr status`; ghx records evidence without
fetching or verifying it. Evidence quotes are limited to 1,000 characters and
10 lines; status may shorten them while the full feedback artifact retains them.

Upgrade participating readers before posting unlocated findings: older versions
show their IDs as open findings with unknown severity instead of reading their
text. Optional provenance on existing located findings remains compatible.

### PR impact and CI validation

```sh
ghx pr impact 12 13 -R owner/repo
ghx pr check 12 -R owner/repo
```

`pr impact` derives `components`, `alsoTouched` and nullable `riskFloor` from
complete changed paths and current config, and reports config provenance. It
works for merged PRs and deleted head branches. Incomplete file lists fail;
stored PR metadata is not changed.

`pr check` validates the block, required data, components, risk and visible-body
drift against config fetched at the PR's pinned target SHA. It ignores local
config edits, reports all validation issues, and never repairs the PR. A policy
change in a PR takes effect after merge. Merge the initial config before making
this command a required check.

In Actions, pass the PR number and base repository explicitly and set
`GITHUB_TOKEN` to `${{ github.token }}`. The standalone binary requires `gh` on
PATH, with no Node runtime or interactive login. Start with `contents: read`
and `pull-requests: read`; `--merge-policy` also needs the Actions/check reads
and access to required-check facts. Unavailable policy facts fail the gate.

`--merge-policy` checks repository gates while excluding CI-user ownership and
merge-write permissions. For a required gate running inside Actions, pass
`--self-check <check-run-id>` with `GITHUB_RUN_ID` set to avoid waiting for that
check itself. Supply your gate's check-run ID, rather than a workflow-run or
Actions-job ID. The command verifies a running check on this PR head in the
current run; the workflow must select its own gate, since ghx cannot infer the
invoking job. Exclusions are returned explicitly. GitHub remains responsible for
aggregate branch-protection readiness; approvals, conflicts, other CI, findings
and preconditions are checked independently. A fork workflow must receive a
token able to read the base repository's PR and policy facts.

## Status

Every v1 command exists, along with passthrough for read-only `gh` commands.
Agent acceptance hasn't run yet: it means scoring the Claude Code sessions of
three real PRs worked on with `ghx` (`scripts/acceptance/score.ts`). Multi-PR
`pr status`, `--fields`/`--brief` and the `run:<id>` and `branch:` CI targets
came from reading how agents used `ghx` in its first week on a real monorepo. The build
order is in [04-build-coordination](docs/plans/04-build-coordination.md).

## Developing

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
