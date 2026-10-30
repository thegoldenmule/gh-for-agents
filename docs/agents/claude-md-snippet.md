## GitHub: use `ghx` in repos that have `.github/ghx.json`

- In a repo with `.github/ghx.json`, use `ghx` for PRs and CI, not raw `gh`. Elsewhere `ghx` reads still work but aren't required. Discover with `ghx --help`, `ghx pr --help`, `ghx <cmd> --help`; check setup with `ghx doctor`.
- Run `ghx` as one plain command: no pipes, `--jq`, `head`, `sleep` or `timeout`. It bounds its own output and time. To keep only some fields, use `--brief` or `--fields a.b,c.d` (a path through an array maps over it), not jq.
- One call per question:
  - PR state, mergeability, CI for the head SHA and feedback: `ghx pr status <pr>` (several: `ghx pr status 12 13 14`).
  - Review and comment threads: `ghx pr feedback <pr>`. Why CI failed: `ghx ci why <pr>`, `ghx ci why run:<id>` or `ghx ci why branch:main`.
- Instead of gh: `gh pr view` → `ghx pr status <pr>`; `gh pr view --comments` → `ghx pr feedback <pr>`; `gh pr checks` → `ghx pr status <pr>` (to wait: `ghx ci wait <pr>`); `gh run view --log-failed` → `ghx ci why run:<id>`; `gh pr ready` → `ghx pr ready <pr>` (`--undo` for draft). Other reads (`pr diff`, `pr list`, `run list`, `api` GETs, …) pass through: `ghx pr diff 12` returns gh's output in a JSON envelope.
- Writes go through ghx, never raw `gh pr create|edit|merge|comment|review|close|ready` or `gh run rerun`. ghx checks repo policy and pins the head SHA.

### PR writes

- Prose (PR bodies, comments, reviews) goes in JSON. Write it to a file with the Write tool, then run `ghx <cmd> --input path.json`. Don't build bodies with heredocs, `echo` or `$(…)`.
- Start from `ghx pr create --example` (this repo's components and the rules), edit it, run `ghx pr create --input pr.json`. Validation runs before any write and reports every issue at once, so no dry-run first. ghx fills `base`, `head` and the components the diff touches, and adds the Claude Code footer itself: don't add one.
- `ghx pr edit <pr> --input patch.json` takes only the fields to change (`ghx pr edit --example`). To wait for green and merge: `ghx pr land <pr>`.
- Warnings such as `FIELD_RENAMED`, `TITLE_PERIOD_REMOVED`, `COMPONENT_ALIAS` or `REDIRECTED` mean ghx fixed your input or ran the right command. It worked; use the form the warning names next time.

### Waiting for CI

Run `ghx ci wait <pr>` with the Bash tool and `run_in_background: true`. Then continue other work or end your turn. Do not poll, sleep, or use Monitor for CI. You will be re-invoked when it exits. Its stdout is the full answer and its exit code is the outcome.

- **In a subagent** (you can't be re-invoked): run `ghx ci wait <pr> --foreground` (or `ghx pr land <pr> --foreground`) in the foreground, without `run_in_background`, with Bash `timeout: 600000`. It returns within 9 minutes; on exit 15 re-run the identical command. Never hand back while a wait runs.
- One wait per PR: a second one only follows the first. Don't read a background wait's output file while it runs.
- A non-zero exit shows as "failed" in the task notification. That label is not the outcome: read the JSON summary (`outcome`, each result's `diagnosis`, `stalled`, `rerunCandidates`) and the exit code below.
- Targets: `<pr>`, `run:<id>` or `branch:<name>`. By default it returns at the first new failure; run the identical command again to continue past it.
- After pushing a fix, wait again. `ghx pr land <pr>` waits until mergeable and merges; `ghx ci wait <pr> --until mergeable` only reports.

### Results and errors

- stdout is one JSON document. Errors are `{"error":{"code","message","hint","details"}}` with a non-zero exit. Follow `hint`; don't retry blindly. Big outputs (logs, diffs) come back as file paths: read the file.
- With several PRs, `pr status` exits 7 if some `results[]` are `error`; the rest are still read.

### Exit codes

| Exit | Meaning | What to do |
|---:|---|---|
| 0 | Success. A read that reports red CI still exits 0 | Read the output |
| 1 | ghx bug | Report it |
| 2 | Usage: unknown command or flag, bad input, failed validation | Fix it as the hint says |
| 3 | `.github/ghx.json` missing or invalid | Fix the config |
| 4 | gh missing, too old or not logged in | Ask a human |
| 5 | PR, repo, run or ref not found | Fix the selector or `--repo` |
| 6 | A ghx policy refused the write | Ask the user, or `--override CODE --reason "…"` |
| 7 | gh or API failure after retries, permission, rate limit | Retry later, or fix access |
| 8 | Deadline exceeded | Retry |
| 9 | GitHub state forbids it now: head moved, conflict, CI pending | Change the state, then retry |
| 10 | `ci wait`: CI is red | Fix it from the diagnosis, or `ghx ci rerun <pr> --flaky`. `workflow-invalid`: fix the workflow file |
| 11 | `ci wait`: red, but every failure is also red on main | Before merging, `ghx ci wait <pr> --until mergeable` |
| 12 | `ci wait`: the head moved, or the PR closed or merged | Re-read with `ghx pr status` |
| 13 | `ci wait`: no checks registered | `merge-conflict`: merge the base and push; else `ghx ci retrigger <pr>` |
| 14 | `ci wait`: a check stalled | Read `stalled`; `ghx ci rerun`, or wait again |
| 15 | `ci wait`: returned before CI settled; state is cached | Re-run the identical command (main thread: in the background) |
| 130, 143 | Interrupted | Re-run if still needed |

Spawning a subagent for PR work? Paste the [coordinator PR template](https://github.com/thegoldenmule/gh-for-agents/blob/main/docs/agents/coordinator-pr-template.md) into its prompt.
