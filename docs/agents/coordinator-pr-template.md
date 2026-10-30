# Coordinator template: PR work in a subagent

Paste the block below into the prompt of any subagent that opens, edits, waits on or merges a PR in a repo with `.github/ghx.json`. Fill in the `<…>` parts. A subagent starts cold: it doesn't see what its siblings learned, and it can't be woken by a background task. This template covers both.

When a subagent reports a rejection the template doesn't prevent, add one line here (or to your shared handoff file) before spawning the next one.

```markdown
## GitHub: PR work with ghx

- Use `ghx`, never raw `gh`, for PRs and CI. Run each `ghx` call as one plain command: no pipes, `&&`, `sleep` or `jq`.
- **Open the PR:** copy `<scratchpad>/last-pr.json` (the last PR JSON ghx accepted) if it exists, or start from `ghx pr create --example`. Write it with the Write tool as `<scratchpad>/<your-name>-pr.json`, edit it, then run `ghx pr create --input <that file>`. No dry-run first: validation runs before any write and lists every issue at once. ghx fills `base`, `head` and the touched components, and adds the Claude Code footer; don't add one. Title: `type(scope): summary`, where the scope, if any, is a component name. Each `testing[].command` is one plain command, with its directory in `cwd`.
- On success, copy your JSON to `<scratchpad>/last-pr.json` for the next agent.
- A warning (`FIELD_RENAMED`, `COMPONENT_ALIAS`, `REDIRECTED`, …) means ghx fixed it and the call worked. Use the named form next time.
- **Wait in the foreground.** You can't be woken by a background task, so never use `run_in_background` or Monitor for CI. Run `ghx ci wait <pr> --foreground` with Bash `timeout: 600000`. It returns within 9 minutes. On exit 15, re-run the identical command. Run one wait per PR; never start a second one on the same PR.
- **To merge:** `ghx pr land <pr> --foreground` waits until the PR is mergeable, then merges. It never merges on red CI. On exit 15, re-run it. <Delete this line if the subagent must not merge.>
- If CI is red (exit 10), the summary has the diagnosis; `ghx ci why <pr>` gives more. Fix, push, and wait again.
- **Don't hand back while a wait or land is running.** Hand back when it has returned with an outcome, or when you're blocked.
- **Report:** the PR ref (`owner/repo#N`), its head SHA, the last wait or land outcome and exit code, and any ghx error code or warning you hit.
```
