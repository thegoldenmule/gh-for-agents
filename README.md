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

None of these commands work yet. They are the v1 plan from [02-api](docs/plans/02-api.md).

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

v1 is under construction. The groundwork is in place (the `gh` wrapper, config,
output contract and test double), and these commands work: `version`, `doctor`,
`init` (which writes a starter `.github/ghx.json`), `help` and `schema`. None of
the `pr` or `ci` commands exist yet. The build order is in
[04-build-coordination](docs/plans/04-build-coordination.md).

To run it from source, you need Node 24, pnpm and `gh` 2.81.0 or later, logged
in. There is no build step and no published package.

```sh
pnpm install
node bin/ghx.js doctor
```

## Design docs

- [Research: how agents use `gh`](docs/research/gh-usage-findings.md)
- [00 Brief](docs/plans/00-brief.md). Its decision sections at the end override the body.
- [01 Scaffolding](docs/plans/01-scaffolding.md)
- [02 API](docs/plans/02-api.md)
- [03 Implementation and testing](docs/plans/03-implementation.md)
- [04 Build coordination](docs/plans/04-build-coordination.md)
