## GitHub: use `ghx`, not `gh`

- Use `ghx` for PRs and CI, not raw `gh`. Run it as one plain command: no pipes, `--jq`, `head`, `sleep` or `timeout`. It bounds its own output and its own time.
- Discover with `ghx --help`, `ghx <cmd> --help` and `ghx <cmd> --schema`. Check setup with `ghx doctor`.
- One call per question:
  - PR state, mergeability, CI for the head SHA and feedback: `ghx pr status <pr>`.
  - All review and comment threads: `ghx pr feedback <pr>`.
  - Why CI failed: `ghx ci why <pr>`.
- Other gh reads (`pr diff`, `pr list`, `issue view`, `run list`, `api` GETs, …) run through ghx: `ghx pr diff 12` returns gh's output in a bounded JSON envelope.
- Writes go through ghx, never raw `gh pr create|edit|merge|comment|review|close|ready` or `gh run rerun`. The ghx verbs check repo policy and pin the head SHA.

### JSON input

- Prose (PR bodies, comments, reviews) goes in JSON. Write it to a file with the Write tool, then run `ghx <cmd> --input path.json`.
- Don't build bodies with heredocs, `echo` or `$(…)`.
- `ghx schema <cmd>` lists the fields. Run a write with `--dry-run` first to see exactly what would be sent.

### Waiting for CI

Run `ghx ci wait <pr>` with the Bash tool and `run_in_background: true`. Then continue other work or end your turn. Do not poll, sleep, or use Monitor for CI. You will be re-invoked when it exits. Its stdout is the full answer and its exit code is the outcome (§6.1).

- A non-zero exit shows as "failed" in the task notification. That label is not the outcome: read the JSON summary (`outcome`, and each result's `diagnosis`, `stalled` and `rerunCandidates`) and the exit code below.
- Don't read the task's output file while it runs, and don't start a second wait on the same PR.
- Exit 15 means the wait handed back early in an unattended session. Run the identical command again, in the background; it resumes from cached state.
- After pushing a fix, wait again. Before merging, `ghx ci wait <pr> --until mergeable` returns the full merge picture in one summary.

### Results and errors

- stdout is one JSON document. Errors are `{"error":{"code","message","hint","details"}}` with a non-zero exit. Follow `hint`; don't retry blindly.
- Big outputs (logs, diffs) come back as file paths. Read the file; don't fetch it again.

### Exit codes (§6.1)

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
| 10 | `ci wait`: CI is red | Read the diagnosis; fix it, or `ghx ci rerun <pr> --flaky` |
| 11 | `ci wait`: red, but every failure is also red on main | Mergeable: go to `ghx pr merge` |
| 12 | `ci wait`: the head moved, or the PR closed or merged | Re-read with `ghx pr status` |
| 13 | `ci wait`: no checks registered | Check the triggers, or `ghx ci retrigger <pr>` |
| 14 | `ci wait`: a check stalled | Read `stalled`; `ghx ci rerun`, or wait again |
| 15 | `ci wait`: handed back while unattended; state is cached | Re-run the identical command in the background |
| 130, 143 | Interrupted | Re-run if still needed |
