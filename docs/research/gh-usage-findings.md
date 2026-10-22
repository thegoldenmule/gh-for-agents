# How Claude Code agents use `gh`: findings from 30 days of transcripts

Research input for a validating, agent-oriented wrapper around the GitHub CLI.

## 0. TL;DR

- Real `gh` errors are rare. About 40 of 1,676 commands hit a genuine gh failure. The cost is in **tool-call volume and hand-written glue**: 1,114 of 1,676 gh commands (66%) pipe output through `head`/`tail`/`grep`/`sed`/`awk`/`cut`, 968 use `--jq`/`-q`, and 334 of 348 CI log fetches are filtered by hand.
- The dominant job is **CI babysitting**. `run view` (548 invocations), `pr checks` (522), `run list` (296) and `gh api .../actions/jobs/N/logs` (~110) together make up over half (55%) of all 2,661 gh invocations. A "why is CI failing" episode takes a **median of 6 gh calls** (112 episodes, max 39).
- **Polling is improvised every time.** There are 232 commands with `sleep`/`until`/`while`, 44 hand-written Monitor scripts that diff `pr checks` JSON with `comm -13`, 41 `--watch`, 98 background runs, 9 calls refused by the harness for a leading `sleep`, and 74 calls wrapped in `perl -e 'alarm 120; exec @ARGV'` because macOS has no `timeout`.
- **`gh run view --log` does not work while a run is still in progress**, so agents fall back to the raw REST job-logs endpoint (102 calls). This is the single largest gap in gh's own UX.
- **PR descriptions conflict with what the user wants.** The user corrected PR bodies twice, in two projects, to "2–3 sentences, no sections, no test logs". Bodies written before the first correction had a median of 2,406 characters; afterwards the median was 568. Titles are conventional-commit in 71 of 73 PRs, but 40 of 73 run over 72 characters.
- **Merges work but have no guardrails.** Of 52 merges, 10 were squash merges, and four squashes earlier went against the user's wishes (recorded in memory). Only 8 used `--match-head-commit`. One merge failure (#3198 conflict) was hidden by `| tail -1`. There were no `--admin` merges, no force-pushes and no `gh api -X` mutations.
- **Commands built from compound shell lines get refused.** 19 calls were rejected by the worktree-isolation guard as "too complex to verify", and 6 by the auto-mode classifier. A wrapper that answers each question in **one plain invocation** avoids this whole class of refusal.

---

## 1. Methodology

- **Corpus.** All 1,240 `*.jsonl` transcripts under `~/.claude/projects/` (1.3 GB): 89 top-level sessions plus 1,151 subagent and workflow-agent transcripts. The window is 2026-09-22 to 2026-10-22.
- **Extraction** (`scratchpad/extract.py`). It streams each file, takes every `Bash` `tool_use` whose command matches `(^|[\s;&|(\`]|$\()gh\s+<word>` anywhere, pairs it with its `tool_result` by `tool_use_id`, and records the project, file, timestamp, command, `is_error`, exit code, result (first 1,500 characters plus a 400-character tail) and the next three gh commands in the same session.
- **Volume.** That gives **1,676 Bash commands** (excluding this session) containing **2,661 gh invocations**, because loops and `;` chains put several invocations in one command. 1,005 of the commands come from subagent transcripts, which is why the counts are well above a naive grep of top-level sessions.
- **Repos.** Activity is dominated by `powerhouse-inc/powerhouse` (1,437 commands), followed by `-recipes` (137) and `sektar` (89).
- **Other tools.** Calls made through other tools were also scanned: 44 `Monitor` scripts and 94 `Agent` prompts mention gh.
- **Memory.** The user's memory files (`~/.claude/projects/*/memory/*.md`) were read because they record **user corrections** about gh behaviour. This is the strongest available signal about what "wrong" looks like.
- **Caveats.**
  - Exit codes are often masked by pipes, so error detection relied on matching message text in results.
  - Message-text buckets that mostly matched CI log *content*, not gh output, were discarded. These were "timed out" (23), "Not Found" (38), "already" (11), "auth" (1) and "Shell cwd was reset" (164, which is informational).
  - One `Bearer` match was in source code, not a token. No tokens appear in this report.

---

## 2. Inventory

### 2.1 Subcommands (invocation counts, top flags)

| Subcommand | Invocations | Most common flags |
|---|---:|---|
| `run view` | 548 | `--json` 286, `--log-failed` 182, `--job` 143, `-q` 135, `--jq` 130, `--log` 78, `-R` 54, `--repo` 20 |
| `pr view` | 534 | `--json` 524, `-q` 266, `--jq` 154, `--repo` 64, `-R` 37, `--comments` 4 |
| `pr checks` | 522 | `--json` 174, `--jq` 89, `--repo` 79, `-R` 53, `-q` 46, `--watch` 41, `--interval` 41 |
| `api` | 313 | `--jq` 130, `-q` 33, `--paginate` 8, `-f` 2 |
| `run list` | 296 | `--json` 286, `--limit` 219, `--branch` 207, `--workflow` 135, `--jq`/`-q` 251, `-L` 42, `--commit` 33, `-b` 21 |
| `pr diff` | 88 | `--name-only` 6; 60 of 71 diff commands redirect to a file or pipe |
| `pr create` | 73 | Every real create passed `--base`, `--head` and `--title` explicitly. `--body` 46, `--body-file` 32, `--draft` 9 (80 regex hits; 7 were text inside memory-file and plan writes) |
| `pr list` | 59 | `--state` 52, `--json` 51, `--limit` 28, `--search` 18, `--head` 14, `--author` 14 |
| `pr merge` | 52 | `--merge` 43, `--repo` 14, `--squash` 8 (10 PRs), `--match-head-commit` 8 |
| `run rerun` | 44 | `--failed` 40, `--job` 3 |
| `pr edit` | 35 | `--body-file` 24, `--body` 8, `--base` 2, `--title` 1 |
| `issue view` | 20 | `--comments` 9, `--json` 8 |
| `run watch` | 15 | `--exit-status` 14, `--interval` 9 |
| `pr ready` | 12 | |
| `run download` | 8 | `-n`, `-D` |
| `search issues` / `search code` | 7 / 2 | `--repo`, `--json` |
| `pr close` / `pr comment` / `pr reopen` / `pr checkout` | 4 / 4 / 1 / 2 | `close --comment` 3 |
| `release list` / `release view` / `repo view` / `workflow list` / `issue list` | 3 / 2 / 2 / 1 / 1 | |
| `pr review`, `issue create`, `issue comment` | **0** | |

Agents almost always name the PR explicitly: `pr checks <N>` in 519 of 520 calls and `pr view <N>` in 533 of 534. Repo context comes from `cd <worktree>` (604 commands start with `cd`) or from `-R`/`--repo` (277 commands).

### 2.2 `--json` fields, grouped by the question being asked

| Question | Fields (count) |
|---|---|
| **Can I merge it?** (`pr view`) | `state` 199, `headRefOid` 155, `mergeable` 140, `baseRefName` 138, `mergeStateStatus` 116, `headRefName` 108, `mergeCommit` 75, `isDraft` 37, `mergedAt` 33, `reviewDecision` 21, `statusCheckRollup` 11 |
| **What is in it?** (`pr view`) | `title` 118, `body` 90, `files` 84, `additions` 25, `deletions` 24, `commits` 18, `changedFiles` 17, `author` 22 |
| **What did reviewers say?** (`pr view`) | `reviews` 14, `comments` 12 |
| **What is CI doing?** (`pr checks`) | `name` 119, `bucket` 109, `link` 63, `state` 46, `workflow` 9 |
| **Which run belongs to my commit?** (`run list`) | `conclusion` 192, `databaseId` 187, `headSha` 165, `status` 108, `createdAt` 81, `name` 68, `workflowName` 60, `headBranch` 41 |
| **Which job failed?** (`run view`) | `jobs` 173, `status` 59, `conclusion` 52, `workflowName` 28, `headSha` 24, `attempt` 20 |

### 2.3 Recurring `--jq` idioms (each is a feature request)

```
13  '.[0].databaseId'                                       # newest run id
 9  '.[] | select(.headSha=="…")'                           # the run for this commit
 7  'group_by(.bucket)|map("\(.[0].bucket)=\(length)")|join(" ")'   # pass=21 pending=1 …
 6  'group_by(.state)|map(...)'                             # same, by state
 5  '[.[]|select(.state=="PENDING" or .state=="QUEUED" or .state=="IN_PROGRESS")]|length'
 5  '.[]|select(.state=="FAILURE")|.link'                   # failing job URL → parse id
 5  '"\(.number) \(.state) \(.mergeStateStatus) base=\(.baseRefName)"'
 4  '.jobs[]|select(.conclusion=="failure")|.databaseId'
 4  '"\(.mergeable) \(.mergeStateStatus)"'
 4  '{title,body,headRefName,baseRefName,files:[.files[]|{path,additions,deletions}]}'
```

Text output is also parsed by hand. 127 commands parse `gh pr checks` tab-separated output with `awk -F'\t'`, and 128 build a pass/fail/pending summary with `uniq -c`, `group_by` or Python `Counter`. 61 commands extract a run or job ID from a check's `link` with `sed -E 's#.*/runs/([0-9]+)/.*#\1#'` or `${l##*/}`.

### 2.4 `gh api` endpoints

| Endpoint (normalised) | Count | Why it was used instead of a porcelain command |
|---|---:|---|
| `repos/:o/:r/actions/jobs/:id/logs` | ~112 | `run view --log` refuses while the run is in progress, and it returns a single job's raw log |
| `repos/:o/:r/actions/runs` / `workflows/:wf/runs` | ~30 | Recent runs of a workflow on `main`, for comparison and duration baselines |
| `repos/:o/:r/actions/runs/:id/jobs` | ~30 | Job IDs and step conclusions (`run view --json` has no `steps` at the top level) |
| `repos/:o/:r/actions/jobs/:id` | ~19 | Step list and conclusion for one job |
| `repos/:o/:r/pulls/:n/comments` | 8 | Inline review comments (path and line). **No porcelain equivalent** |
| `repos/:o/:r/pulls/:n/reviews` | 6 | Review verdicts and bodies |
| `repos/:o/:r/issues/:n/comments` | 5 | Conversation comments |
| `check-runs/:id/annotations`, `check-suites/:id/check-runs` | 7 | Annotations |
| `issues/:n/timeline` | 2 | Find out why the base changed (`automatic_base_change_succeeded`) |
| Other repos: releases, contents, readme | ~15 | Research on third-party repos |

No `gh api` call used `-X POST/PATCH/DELETE` (0 mutations).

---

## 3. Mistakes and failures

### 3.1 Genuine `gh` errors (verified by reading the results)

| Root cause | Count | Example (verbatim) | How the agent recovered |
|---|---:|---|---|
| **Logs requested while the run is in progress** | 16 | `gh run view --job $j --log` → `run 37948190914 is still in progress; logs will be available when it is complete` | Switched to `gh api repos/powerhouse-inc/powerhouse/actions/jobs/<id>/logs` (102 such calls overall). Often one or two calls were lost first. |
| **"no checks reported" right after a push** | 11 | `gh pr checks 3264 -R powerhouse-inc/powerhouse --json name,bucket` → `no checks reported on the 'fix/recipes-e2e-align-router' branch` | Polled again with sleep/until; some sessions polled `run list --commit <sha>` until it was non-empty |
| **`gh issue view --comments` printed nothing** (or only comments, with no body) | 4 of 9 calls | `gh issue view 2894 --comments 2>&1 \| head -150` → empty output | Re-ran with `--json title,state,body,comments,author --jq '…'` |
| **Unknown `--json` field** (run-level vs job-level confusion) | 3 | `gh run view … --json jobs -q '… .steps[] …'` → `Unknown JSON field: "steps"` (also `"path"`) | `gh run view <id> --json jobs -q '.jobs[]\|select(.name=="…")\|.steps[]'` or `gh api …/actions/jobs/<id>` |
| **Diff too large** | 2 | `gh pr diff 3169` → `HTTP 406: Sorry, the diff exceeded the maximum number of files (300)` | Fetched the branch and ran a local `git diff` |
| **Rerun refused** | 2 | `gh run rerun 37368109268 --failed` → `cannot be rerun; This workflow is already running` and `job 111978835495 cannot be rerun` | Waited, or moved on |
| **No git repo for context** | 2 | `cd …/scratchpad && gh run view 36595098099 --job … --log-failed` → `failed to determine base repo: … not a git repository` | Added `-R powerhouse-inc/powerhouse` |
| **PR looked up in the wrong repo** | 1 | In the `sektar` checkout, `gh pr view 3258 --json …` → `GraphQL: Could not resolve to a PullRequest with the number of 3258` (the PR was created in `powerhouse` from a worktree) | `gh pr view 3258 -R powerhouse-inc/powerhouse …` |
| **Transient GraphQL error on merge** | 1 | `gh pr merge 3214 --repo powerhouse-inc/powerhouse --merge` → `GraphQL: Something went wrong while executing your query…` | Ran the identical command again, which succeeded |
| **PR already merged** | 1 | `gh pr merge 3211 --merge` → `! Pull request powerhouse-inc/powerhouse#3211 was already merged` | None needed |
| **No `timeout` binary on macOS** | 1 | `timeout 120 gh pr create …` → `(eval):1: command not found: timeout` | Re-ran without it; elsewhere agents used `perl -e 'alarm 120; exec @ARGV' gh …` (74 calls) |

No calls showed an unknown-flag error, an auth error, a gh rate-limit error (the only "rate limit" match was Docker Hub inside a CI log), or a pager hang. Pager problems are avoided implicitly because every command is piped.

### 3.2 Harness and permission refusals a wrapper would avoid

| Cause | Count | Example | Fix |
|---|---:|---|---|
| **Worktree-isolation guard: command "too complex to verify"** | 19 | `perl -e 'alarm 120; exec @ARGV' gh run list --workflow e2e-tests.yml …` → refused. `gh pr create … --body "$(printf '%s\n\n%s' …)"` → refused | Agents split the work into plain single commands and retried, costing one extra call each time |
| **Harness blocked a leading `sleep N; gh …`** | 9 | `sleep 60; gh pr checks 3196 2>&1 \| head -40` → `Blocked: sleep 60 followed by … use Monitor with an until-loop` | Re-ran without the sleep, then wrote an until-loop or Monitor script |
| **Auto-mode classifier denial** | 6 | `gh pr view 3114 … && gh pr merge 3114 --repo powerhouse-inc/powerhouse --merge` → `[Merge Without Review]`. `gh pr edit 3168 --base feat/reactor-worker-packaging 2>&1 \| tail -1; …` → denied, and **the identical `gh pr edit` without the pipe succeeded 3 minutes later** | Plain commands with a clear purpose pass. Chains that mix reads and writes look suspicious |

### 3.3 Failures hidden by output handling

- **A merge failure hidden by `tail`.** The full command was `s=$(gh pr view 3198 --json state -q .state); [ "$s" = OPEN ] && gh pr merge 3198 --merge 2>&1 | tail -1; sleep 8; gh pr view 3198 …`. The merge was blocked by a conflict, but `tail -1` left only the hint line `gh pr checkout 3198 && git fetch origin main && git merge origin/main`. The agent learned that the merge had failed only because the follow-up `pr view` still said `OPEN`.
- **Exit codes swallowed by pipes.** `2>&1 | head`/`tail` appears throughout. `gh pr checks` uses exit 8 for "pending" and 1 for "failing", and that signal is lost in every piped call.
- **Logs and stderr thrown away.** `2>/dev/null` is used on log fetches, so "still in progress" turned into an empty result in 8 `--log-failed` calls.

### 3.4 Retry loops

These were the most common correction sequences:

1. `run view --log` returns "in progress", then the agent finds the job ID through `pr checks --json link` and `sed`, then calls `gh api …/jobs/ID/logs | sed 's/\x1b\[[0-9;]*m//g' | grep -E ' FAIL |×|…' | head`. This takes 2–4 calls.
2. `issue view --comments` prints nothing, so the agent switches to `issue view --json …,comments --jq '…'`. This takes 2 calls.
3. A compound command is refused, so the agent splits it into N plain commands. This costs N+1 calls, and 19 calls were refused this way.
4. `sleep N; gh …` is blocked, so the agent runs `gh …` alone, then an until-loop, Monitor script or `--watch` in the background. This takes 2–3 calls.

---

## 4. Content quality of writes

### 4.1 `gh pr create`

**Titles (73 PRs).**
- 71 of 73 follow Conventional Commits (`type(scope)!: …`).
- The exceptions are `doc-harness: second full run, the doc defects it verified, and the harness gaps it exposed` and the literal title `$2`, which is an artifact of a shell-function batch, shown below.
- **40 of 73 titles are longer than 72 characters.** The median is 74 and the maximum 151, for example `fix(builder-tools): the project shell prerender runs connect and connect-core through vite, so their import.meta.env reads work when installed from npm`.
- Some titles append series tags such as `(multi-reactor slice 10a)` and ` (#2894)`.
- Scopes are inconsistent: `codegen,vetra`, and a missing scope on `feat: peer protocol agreement`.

**Bodies (71 non-trivial bodies).**
- **Length.** Bodies created on or before 2026-09-25 (20 PRs) had a median of 2,406 characters, and 13 of 20 had markdown headings. After the user's correction they dropped to a median of 568 characters, with headings in 8 of 51.
- **Footer.** 89 of 92 create and edit bodies carry the `🤖 Generated with [Claude Code]` footer.
- **Structure.** Typical bodies are one prose paragraph and the footer. When headings exist they are ad hoc: `Verification` 8, `Summary` 6, `Tests` 5, `Not in this PR` 4, `Problem` 4, `Test plan` 4, `Root cause`, `Deviations from the plan`, `Known fragility`, `Rollout`.
- **Testing, risk and revert.** A testing section appears in 19 bodies and a test mention in 36. "Risk" never appears as a section. Revert or rollback is mentioned in 4 bodies, and a checklist appears in 4. Breaking changes are flagged in 8 (`!:` in the title plus prose).
- **Stacking.** 19 bodies mention it (`Stacked on #3105.`), and 16 of 73 PRs were opened against a non-`main` base.
- **Typical post-correction body (verbatim):**
  > The supergraph SSE schema was built with buildSubgraphSchema, which throws on any type two subgraphs both define (Query included), so registering a second subscription subgraph took /graphql/stream down. It now merges subscription subgraphs with … A subgraph that does not build is excluded with one error log naming it, and the stream stays up for the rest.
  >
  > 🤖 Generated with [Claude Code](https://claude.com/claude-code)

**User corrections (from memory files). These are the most important design input.**

- `feedback_pr_description_length.md` (powerhouse, 2026-09-25): "Keep pull request descriptions to 2-3 sentences … No headings, bullet sections, file lists or test-result logs. **Why:** the user trimmed the PR #3124 description (a multi-section write-up)…"
- `pr-descriptions-short.md` (sektar, 2026-10-20): "I opened PR #3258 with a long body (summary sections, prioritized issues, test plan); the user said 'that is not what I asked you to do. the pr should be at most a few lines long.'"

> **Design tension.** The motivating idea collects `{testing, risk, components, revertPolicy}`, but this user explicitly does not want test plans or sections in the PR body. The wrapper should **validate** those fields, because their presence forces the agent to think, but it should render the body compactly: a ≤3-sentence description plus a one-line machine-readable trailer or a collapsed `<details>` block, or keep them as metadata such as labels or an HTML comment. The rendering policy has to be configurable per repo.

**How bodies were passed, and quoting problems.**
- Bodies were passed as `--body-file` (28), `--body "$(cat <<'EOF' … EOF)"` (23), inline `--body "…"` (19), or stdin heredoc (2).
- Inline bodies need backticks escaped by hand (`--body "Connect gains an optional \`multiReactor\` runtime flag…"`), and 6 inline bodies contained `\``.
- One inline body using `$(printf '%s\n\n%s' …)` was refused by the worktree guard. It was re-submitted with `--body-file`, and **the title silently changed** from `…by createdAt, id` to `…by createdAt and id`.

**Batch creation via a shell function (verbatim):**
```
F=$'\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'; S="Split out of #3167 so it can be reviewed and merged on its own; …"
mk() { gh pr create --base main --head "$1" --title "$2" --body "$3 $S$F" 2>&1 | tail -1; }
mk fix/reactor-windows-tests "fix(reactor): make the reactor suite pass on Windows" "Spawns pnpm through cross-spawn, …"
mk docs/testing-policy "docs(plans): testing policy, rollout, and seam tests" "…"
… (8 PRs, #3171–#3178)
```
This worked, but it is unvalidated. A `pr create --batch file.json` would make it safe.

**Other anomalies.**
- A PR was created cross-repo from the `sektar` project (`cd ~/.worktrees/powerhouse/host-icons && gh pr create …` → `powerhouse/pull/3258`). Later lookups from the sektar cwd then failed.
- No duplicate PRs were found. No PR was opened against an obviously wrong base, although #3194 and #3195 were **auto-retargeted** to `main` by GitHub (`automatic_base_change_succeeded`) when their base branch merged, and the agent had to dig through `issues/3194/timeline` to find out why.
- Drafts were used for stacked slices (9 creates), which matches the user's rule "base main as ready, or as a draft stacked on its base slice".

### 4.2 `gh pr edit`

35 invocations across 24 PRs, almost all body rewrites:
- **Body churn.** #3088 and #3210 were each edited 4 times, and #3083, #3168, #3212 and #3214 twice each. Many edits applied the "shorten the body" rule after the fact.
- **Base changes.** 2 of the edits retargeted the base (`gh pr edit 3168 --base feat/reactor-worker-packaging`, denied once by the classifier).
- **Title change.** One edit changed the title.

### 4.3 `gh pr merge`

There were 52 invocations.
- `--merge` was used 43 times. `--squash` was used 8 times, covering 10 PRs: #3088 with `--subject/--body-file`, and the split PRs #3171–#3178.
- 14 merges passed `--repo`, and 8 passed `--match-head-commit <sha>`. All 8 were in one disciplined session (PR-A to PR-G on 2026-10-13).

Related user corrections:
- `feedback_merge_commit_not_squash.md`: "Earlier, four PRs were squash-merged against the user's wishes … Default to `--merge` … confirm before squashing anything."
- `feedback_only_own_prs.md`: "I listed #3169 (another author's PR) … because I filtered by `number >= 3167`; the user objected." The rule is `gh pr list --author @me`.
- `feedback_merge_when_main_shares_red.md`: "When a PR's only red CI check is the same failure main already shows, treat the PR as green and merge it." This explains the 128 `run list --branch main` calls.

### 4.4 `gh pr comment` / `gh pr close --comment` / `gh pr review`

These are covered in §8(d).

---

## 5. Workflow patterns

### 5.1 "Why is CI failing?"

This is the most common workflow. Measured as episodes of consecutive CI-related gh calls in a session (checks, run list, run view, jobs, logs, rerun, watch): there were **208 CI episodes, and 112 included a log fetch**. Those 112 took a **median of 6 gh calls and a mean of 7.1**, with a maximum of 39. Log fetches total 348: 168 `--log-failed`, 78 `--log`, and 102 via the API.

A verbatim chain (session 2c78e9b7, 2026-10-09; output abbreviated):
```
15:31:11  for p in 3187 3197 3198 3204; do echo "#$p $(gh pr view $p --json state,mergeable -q '[.state,.mergeable]|join(" ")') $(gh pr checks $p 2>/dev/null | awk -F'\t' '{print $2}' | sort | uniq -c | tr -s ' ' | tr '\n' ',')"; gh pr checks $p 2>/dev/null | awk -F'\t' '$2=="fail"{print "   FAIL "$1}'; done
          => #3198 OPEN MERGEABLE  1 fail, 12 pass, 7 pending, 3 skipping,  FAIL Test Reactor (shard 1/3)
15:31:26  l=$(gh pr checks 3198 --json name,link,bucket -q '.[]|select(.bucket=="fail")|.link'); j=${l##*/}; gh run view --job $j --log 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E ' FAIL |AssertionError|Tests .*failed|expected|still in progress' | cut -c1-250 | head
          => run 37948190914 is still in progress; logs will be available when it is complete
15:47:03  l=$(gh pr checks 3187 --json link,bucket -q '.[]|select(.bucket=="fail")|.link'); j=${l##*/}; r=$(echo $l | sed -E 's#.*/runs/([0-9]+)/.*#\1#'); gh run view --job $j --log 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E ' FAIL |×|Tests .*failed|still in progress' | cut -f3- | cut -c1-220 | head -8
          => … packages/reactor-api test:  × should converge after reshuffle rebroadcast between two connect reactors 20056ms
15:47:17  … gh run rerun 37951014406 --failed && echo "rerun #3187 windows"
```

Every step here belongs inside the tool. That means mapping a failing check to its run and job, waiting for or working around "in progress", stripping ANSI codes and the `job\tstep\ttimestamp` prefix, extracting failing test names and assertion lines, and comparing against `main`.

Grep tokens used on logs: `FAIL` 147, `error` 42, `✘` 20, `Test Files` 10, `##[error]` 9, `failed` 6, `ERR_PNPM` 3. Logs were saved to a file 131 times and then read in several more calls. `head -N` sizes varied between 3 and 60, so agents were guessing how much to read.

### 5.2 Waiting for CI

| Mechanism | Count |
|---|---:|
| Commands containing `sleep`/`until`/`while` | 232 |
| … of which until/while loops | 88 |
| Leading `sleep N;` (9 were blocked) | 39 |
| `gh pr checks --watch --interval N` / `gh run watch --exit-status` | 41 / 15 |
| `run_in_background: true` gh commands | 98 |
| `Monitor` tool scripts polling gh | 44 |
| `pr checks <N>` calls per (session, PR) | median 3; 37 PRs polled ≥5 times; max 22 |

Monitor scripts re-implement the same transition-diffing logic every time (verbatim excerpt):
```
prev=""
while true; do
  s=$(gh pr checks 3266 -R powerhouse-inc/powerhouse --json name,bucket 2>/dev/null || echo '[]')
  cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
  comm -13 <(echo "$prev") <(echo "$cur")
  prev=$cur
  ...
```

Related edge cases:
- "No checks reported" for the first 10–60 seconds after a push (11 instances).
- `mergeable: UNKNOWN` immediately after a push or a merge into the base. Agents add `sleep 5`–`20` and re-query. In 20 of 52 merges, the reads just before the merge showed `UNKNOWN`.
- One session polled `githubstatus.com` during an Actions outage.

### 5.3 Merge-readiness and merging

The usual sequence:
1. `gh pr view N --json state,mergeable,mergeStateStatus,headRefOid,reviewDecision`
2. `gh pr checks N | awk … | uniq -c`
3. Optionally, `gh run list --branch main --workflow … --json headSha,conclusion` to check whether `main` is red too
4. `gh pr merge N --merge 2>&1 | tail -2`
5. `sleep 5–10; gh pr view N --json state,mergeCommit -q '.state+" "+.mergeCommit.oid[0:10]'` to confirm

Session-PR pairs touching both CI and merge state used a median of 5 calls. Merges were frequently run in a loop over a stack, merging origin/main into the remaining branches after each merge. The orchestration memo reads: "Order: G -> A/B/C as ready -> D -> E (retarget main) -> F (retarget main). Gate: review done + CI fully green."

### 5.4 Smaller recurring patterns

- **Rerunning failed jobs.** `gh run rerun <id> --failed` was used 40 times, usually after finding the run ID by parsing a check link. It was refused twice (already running, or job not rerunnable). A guarded loop (verbatim): `for r in $(gh pr checks 3197 --json bucket,link --jq '.[]|select(.bucket=="fail")|.link' | sed -E 's#.*/runs/([0-9]+)/.*#\1#' | sort -u); do st=$(gh run view $r --json status --jq .status); [ "$st" = completed ] && gh run rerun $r --failed; done`
- **Retriggering CI by close and reopen.** `gh pr close 3187 && gh pr reopen 3187 && sleep 20; gh run list --branch …`, used to fire `pull_request` workflows after a base change.
- **Matching a run to a commit.** 175 commands use `headSha` filters and 150 use `headRefOid`. Agents constantly check that the CI they are reading belongs to the current head.
- **Comparing with main.** 128 `run list --branch main` calls. This is driven by the "merge when main shares the red" rule and by flake triage.
- **Push, create, verify.** `git push -q -u origin <b> 2>&1 | grep -vE '^remote:'; gh pr create …`. 67 gh commands also contain `git push`, and every push prints a multi-line `remote: GitHub found 2xx vulnerabilities …` Dependabot banner that agents filter out with `grep -vE '^remote:'`.

---

## 6. Output-handling pain

- **Filtering.** 1,114 of 1,676 gh commands pipe output through `head|tail|grep|sed|awk|cut`.
- **Logs.**
  - 334 of 348 log fetches are filtered, and 101 strip ANSI escapes (`sed 's/\x1b\[[0-9;]*m//g'`).
  - About 23 strip the `job<TAB>step<TAB>timestamp` prefix (`sed 's/^[^\t]*\t[^\t]*\t//'`, `cut -f3-`).
  - `--log-failed` output labels every line `UNKNOWN STEP`, so step attribution is lost.
- **JSON post-processing.** 968 commands use `--jq`/`-q`, 48 pipe to `jq`, and 12 pipe to `python3 -c 'import json…'`. The jq is mostly formatting into one line, grouping by bucket, or selecting the failing item.
- **Large results.** 147 results exceeded 5,000 characters and 6 exceeded 20,000. 5 were persisted to disk by the harness as "Output too large" (`gh pr diff 10 > …`, full job logs).
- **Diffs.** 60 of 71 `pr diff` commands redirect or pipe, and 7 are `| wc -l`, just to size the diff. Two hit the 300-file HTTP 406 limit.
- **Noise rows in `pr checks`.** Agents filter by hand `notify-discord` (skipped ×3), duplicate `CI duration watch` rows (one per workflow), and `do-codegen-tests-windows` (skipped).
- **Misleading green.** From memory `trap_workflow_ui_skipped_on_prs.md`: a job can be green with its test *step* skipped. The rule recorded there is to check the step's conclusion rather than the job's. The agent cannot see this from `pr checks`.

---

## 7. Dangerous and irreversible operations

| Operation | Count | Notes |
|---|---:|---|
| `gh pr merge` | 52 | 10 PRs squashed. Memory records that four PRs were squash-merged against the user's wishes, and that the user said "Do not squash" when a coordinator recommended squashing #3206. |
| `--admin`, `--auto` | 0 | |
| `gh pr close` | 4 | All carried a reason via `--comment`, except the close+reopen used to retrigger CI. One used `--delete-branch` and failed to delete the local branch because a worktree held it. |
| `gh api -X POST/PATCH/DELETE` | 0 | |
| `git push --force` adjacent to gh | 0 | 67 plain pushes |
| Merge with a red check | 1 confirmed | #3246 merged with `Test (shard 3/3) fail` on 2026-10-19, under the user's rule from that same day ("if main is failing on the same thing, it is safe to merge"). Whether main shared the failure was checked by hand. |
| Merge while `mergeable` was `UNKNOWN` | several | For example #3204, where the call printed `UNKNOWN UNKNOWN main` and then `MERGED`. GitHub enforces the state server-side, so this is not unsafe, but the agent's own check was meaningless. |
| Merge blocked by a conflict and not noticed at once | 1 | #3198 (§3.3) |
| Classifier "Merge Without Review" denials | 2 | `reviewDecision` was `""` on effectively every PR observed. These repos do not require reviews, and agents merge their own PRs after the user authorises them. |

Overall nothing reckless happened. The risk lies in policy drift: squash versus merge, other people's PRs, and merging with red checks. Today those policies live in memory files, and a wrapper could enforce them.

---

## 8. Read side: PR description, comments and CI state

This section was added at the coordinator's request for a planned `pr view` that folds everything into one object.

### (a) What agents look for, and the question behind it

| Question | Calls and fields actually used |
|---|---|
| **Merge-readiness: can this land now?** | `pr view --json state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,reviewDecision` together with a `pr checks` summary (pass/fail/pending counts). This is the single most frequent read: `state` 199, `mergeable` 140, `mergeStateStatus` 116. |
| **Is CI for the current head?** | `headRefOid` (150 commands), compared with `headSha` from `run list` (175 commands) |
| **What failed and why?** | `pr checks --json name,bucket,link` → parse the job ID from `link` → `run view --job --log[-failed]` or `api jobs/N/logs` → grep. Also `run view --json jobs` for step conclusions, and `run list --branch main` to see whether main fails the same way. |
| **What is this PR about?** (reviewing others' PRs, or picking up one's own later) | `pr view --json title,body,files,additions,deletions,commits,author,baseRefName,headRefName`, often reshaped with jq into `{title,body,files:[path +a -d]}` (5 calls). `pr diff` saved to a file. |
| **What feedback exists?** | `pr view --json reviews,reviewDecision,comments`, `api pulls/N/reviews`, `api pulls/N/comments` (inline), `api issues/N/comments`, `pr view --comments`, and for issues `issue view --json …,comments` |
| **How do I test it?** | Not asked of the PR. Agents never read a PR body to learn how to test it; they read plans in `docs/plans/` and memory files instead. |
| **What happened to the base?** | `api issues/N/timeline` filtered on `base_ref_changed` / `automatic_base_change_succeeded` |

### (b) Calls needed to assemble one PR's full state

Measured across 308 (session, PR) pairs that reference a PR number:
- The median was 2 calls, the 90th percentile 6 and the maximum 14. CI log fetches reference run and job IDs, not the PR number, so this undercounts.
- Facet coverage was usually partial. 106 pairs read only the description, 36 read CI plus merge state, 31 read CI only, and 12 read CI plus logs. **Only a handful assembled description, feedback, CI and failing log together, because doing so takes 5–8 calls:**
  1. `pr view --json title,body,state,mergeable,mergeStateStatus,headRefOid,isDraft,baseRefName,reviewDecision`
  2. `pr view --json comments,reviews` (conversation comments and review summaries)
  3. `api repos/:o/:r/pulls/N/comments` (inline review comments with path and line)
  4. `pr checks N --json name,bucket,link`
  5. Parse the job ID, then `run view --job J --log` (or `api …/jobs/J/logs` while in progress), filtered
  6. Optionally `run list --branch main --workflow W --json headSha,conclusion` to compare with main
  7. Optionally `run view R --json jobs` for step-level conclusions (the skipped-step trap)

  One agent did exactly this in a loop (verbatim):
  ```
  for n in 2970 2974 2975; do gh pr view $n --comments --json comments,reviews --jq '.comments[] | "[\(.author.login) \(.createdAt)] \(.body)"' | head -80;
    gh api repos/{owner}/{repo}/pulls/$n/reviews --jq '.[] | "[REVIEW \(.user.login) \(.state)] \(.body)"' | head -60;
    gh api repos/{owner}/{repo}/pulls/$n/comments --jq '.[] | "[INLINE \(.user.login) \(.path):\(.line)] \(.body)"' | head -80; done
  ```
- **Three separate sources hold PR feedback** (issue comments, reviews, inline review comments), and `gh pr view --comments` covers only the first two. Inline comments always need `gh api`.

### (c) What comments look like in practice

Observed comment types:

1. **Structured human code review**, posted as a PR comment (written by the user or by an agent on their behalf):
   ```
   ## Code review
   Reviewed the 15 files on `agent/issue-2894` plus the surrounding sign/verify call graph (…).
   The headline: **the replay this PR is meant to close is still reachable on the main write path.**
   ### High
   **1. `packages/shared/document-model/crypto.ts:179` — the unbound candidate is always accepted**
   <explanation, concrete repro>
   **2. `packages/reactor/src/client/reactor-client.ts:1071` — the primary write path never binds `documentId`** (also `:1111`, `:1130`)
   ```
   The implicit schema is `{scope reviewed, headline, findings: [{severity: High|Medium|Low, path, line, title, body, alsoAt[]}]}`.
2. **Human review verdicts** (`CHANGES_REQUESTED`) with numbered suggestions: "I think we need to approach this problem differently … 1. Provide an explicit error when a document already exists … 2. … 3. … 4. …"
3. **Bot inline review comments** (Copilot), shaped `path:line [Copilot] <suggestion>`, for example "`packages/reactor/src/core/utils.ts:296` [Copilot] `signAction` now always binds signatures to the provided `documentId`, but it doesn't guard against an empty string… Add a fail-fast check…"
4. **CI bot comments**, for example a marker-tagged `<!-- ci-duration-watch -->` comment containing `### ⚠️ CI duration regression` and a table `| Job | This run | Baseline median | …`. These show up mixed into `.comments[].body` alongside human text, and agents must skip them.
5. **Agent coordination comments**, for example "Rebased onto main after #3184 merged. Merge only after a release that includes #3184 (the client selects fields older Switchboards don't serve)." and "Rebased onto the updated #3185; stays draft until #3185 merges." These are **merge preconditions written as prose**, so nothing enforces them.
6. **Harness and closure notes**, for example "The issue harness could not get this past its gates; closing and cleaning up." and "Superseded by #3250. … Your commit is credited as co-author there."

**How agents parse and act on comments.**
- They flatten everything to `author state: body` lines with jq, then read it.
- They filter by state, for example `.reviews[]|select(.state=="CHANGES_REQUESTED")`.
- They grep: one agent searched five merged PRs for open review findings with `gh pr view $n --comments | grep -iE -A3 '\blows?\b|open low'` and found nothing, because the review findings lived in scratchpad reports, not on the PR.
- Addressed or unaddressed state is never tracked on GitHub. Agents keep it in `TRACKER.md` files and memory notes (for example "PR4 r3: 2 confirmed + 1 plausible … Fix … -> reports/pr4-r3-fix.md").

**Structure worth formalising.** Each review finding would carry:
- `severity`: high, medium or low
- `path:line`, plus any other locations (`alsoAt[]`)
- `title`
- `body`
- `status`: open, addressed (with a commit sha), won't fix or deferred
- `verdict` for the review as a whole: approve, request changes or comment

Coordination comments would carry `{kind: precondition|status|supersede, refs: [#N], condition}`. Bot comments would be recognised by marker or author and returned as a separate `bots[]` list. This would let the planned `pr view` return `feedback.open[]` directly and let `pr merge` refuse while open high-severity findings or unmet preconditions exist.

### (d) Comment and review writes

- `gh pr comment`: 4 calls. One was the structured code review above (written to a file, then `--body-file`). One was a long slice summary on #3168 ("This PR won't be merged as-is. Its functionality was split into reviewed slices … - **#3184** (8a): adds `executeBatch`…"). Two were one-line coordination notes on #3185 and #3187.
- `gh pr close --comment`: 4 calls, giving reasons for superseded or redundant PRs, including a loop closing #2975, #2974 and #2970 with one shared rationale.
- `gh pr review`: **0**. Agents never used GitHub's review API, so findings were posted as plain comments and verdicts were lost.
- `gh issue create` / `issue comment`: 0.

---

## 9. Ranked recommendations

Ranking weighs calls saved, errors prevented, and alignment with recorded user corrections.

### 1. `ci why <pr|run>`: diagnose failing CI in one call

- **Evidence.** 112 diagnosis episodes at a median of 6 calls. 348 log fetches, of which 334 were hand-filtered and 101 ANSI-stripped. 102 REST log fallbacks. 16 "still in progress" failures. 61 link→ID `sed` parses.
- **Behaviour.**
  - Resolve PR → head SHA → failing checks → runs and jobs → failing steps.
  - Fetch per-job logs through the jobs API, which works mid-run.
  - Strip ANSI codes and prefixes, and extract failing test names, assertion lines, `##[error]` lines and the exit line, with a bounded excerpt per job.
  - Report `step skipped` for green jobs whose key step was skipped.
  - Optionally include `--compare main`, which says whether the same job and test fail on the latest `main` run.
- **Output.** `{head, failing:[{workflow, job, jobId, runId, step, tests:[…], excerpt, logPath, sameOnMain}]}`.

### 2. `ci wait <pr> [--until settled|green|first-failure] [--timeout]`: polling built in

- **Evidence.** 232 sleep/poll commands, 44 Monitor scripts, 41 `--watch`, 98 background runs, 9 blocked sleeps, 74 perl-alarm wrappers, 11 "no checks reported", and median 3 (max 22) `pr checks` calls per PR.
- **Behaviour.**
  - Treat "no checks yet" as pending until a grace period has passed.
  - Bind to the head SHA, and restart if the head changes.
  - Emit one line per transition.
  - Apply a built-in timeout, so no external `timeout`/`perl` is needed.
  - Use exit codes that distinguish green, red, timeout and superseded.
  - Ignore configured noise checks (`notify-discord`).

### 3. `pr status <pr>`: one structured object for the PR

This is the planned `pr view`.

- **Evidence.** 289 merge-state reads and 392 checks reads, 5–8 calls for the full picture, 3 sources for feedback, 150/175 head-SHA cross-checks, 128 main comparisons, and `UNKNOWN` mergeability just before 20 of 52 merges, handled with sleep-and-retry.
- **Contents.**
  - `{number, repo, title, description, base, head:{ref,sha}, draft, state, mergeable (retried until known, with a bound), mergeState, reviewDecision}`
  - `ci:{pass,fail,pending,skipped, failing:[…], forHeadSha:true}`
  - `feedback:{reviews[], findings[] (structured, with status), comments[], bots[]}`
  - `preconditions[]`
  - `stack:{parent, children, baseAutoChanged}`
- **Behaviour.** Require an explicit repo, or resolve it from the PR URL, and error clearly on a cwd/repo mismatch (the sektar #3258 case).

### 4. `pr create` with structured, validated input and compact rendering

- **Evidence.** 40 of 73 titles are over 72 characters. There were 2 user corrections on body length. 23 heredoc and 19 inline bodies needed escaping. One body was refused for shell complexity and its title drifted on retry. One cross-repo create. The literal `$2` title came from shell batching. Bodies were edited up to 4 times.
- **Validation.**
  - Conventional-commit title of at most 72 characters, with a scope from an enum of components.
  - Description of at most 3 sentences or lines.
  - `testing`, `risk` and `revertPolicy` required but rendered per repo policy (compact trailer or `<details>` by default) so the body stays short.
  - Explicit `repo`, `base` and `head`.
  - `draft` derived from the stack: draft if the base is not the default branch, ready otherwise.
  - Attribution footer added automatically.
  - Input as JSON on stdin or from a file, so there is no quoting.
  - A `--batch` form for split-out PR series.
  - Refuse to create a PR for a branch that already has an open one.

### 5. `pr merge` with policy and verification

- **Evidence.** 8 of 52 merges pinned the head SHA. 10 squashes, against a recorded "never squash" preference. The #3198 conflict was hidden by `tail`. A transient GraphQL failure on #3214. Classifier denials. An "only my PRs" correction. A "merge when main shares the red" rule.
- **Behaviour.**
  - Always pin `--match-head-commit`.
  - Take the merge method from repo policy (default `merge`, require an explicit override for squash).
  - Refuse on red checks unless `--allow-red-if-on-main`, which runs the `ci why --compare main` check.
  - Refuse when the PR author is not `@me`, unless forced.
  - Refuse on unmet preconditions or open high-severity findings.
  - Retry transient API errors.
  - Return the final `{state, mergeCommit}` instead of requiring a `sleep; pr view`.
  - Report conflicts as a structured error with a suggested fix.

### 6. `pr feedback <pr>` and a structured `pr comment` / `pr review`

- **Evidence.**
  - Feedback is spread over 3 API sources.
  - Review findings exist only as prose, while open-or-addressed state lives in scratchpad trackers.
  - Bot comments are mixed into human ones.
  - `gh pr review` was used 0 times.
  - The "open lows" search found nothing.
- **Behaviour.**
  - Read all three sources merged and sorted, with bots separated.
  - Write review findings as `{severity, path, line, title, body}`, posted as a real review with inline comments and a verdict.
  - Support `feedback resolve <id> --commit <sha>` to track addressed state.
  - Support coordination comments typed as `precondition` (enforced by `pr merge`) or `status`.

### 7. One plain invocation per question

This is a design rule rather than a command.

- **Evidence.** 19 worktree-guard refusals and 6 classifier denials, all on compound pipelines mixing reads and writes. The identical `pr edit --base` passed once it was a plain call.
- **Rule.** Every wrapper command must answer its question without the caller piping or chaining, and read and write commands stay separate. That makes calls auditable by guards and allowlists.

### 8. `ci rerun <pr> [--failed]` and `ci retrigger <pr>`

- **Evidence.** 44 reruns, mostly after parsing IDs by hand. 2 refusals (already running, or job not rerunnable). The close+reopen hack to retrigger `pull_request` workflows.
- **Behaviour.** Preflight the run's status, rerun only completed failed runs for the current head, and offer an explicit retrigger instead of close and reopen.

### 9. Field and argument validation with useful suggestions

- **Evidence.** 3 unknown-field errors confusing run-level and job-level fields (`steps`, `path`). `--json` fields are typed out by hand in 1,000+ calls. `issue view --comments` printed nothing on 3 of 8 calls.
- **Behaviour.** Fixed, typed output schemas instead of free `--json` lists, so field errors become impossible. Where pass-through is allowed, validate against gh's field list and suggest the nested path, for example "`steps` is under `jobs[]`".

### 10. Bounded, file-backed output by default

- **Evidence.** 147 results over 5,000 characters, 5 persisted as too large, 60 of 71 diffs redirected to files, 131 logs saved to files, `head -N` guesses from 3 to 60, and two 300-file diff failures (HTTP 406).
- **Behaviour.**
  - Summaries in stdout, with full artifacts written to a path the result returns.
  - `pr diff --stat|--files|--path <glob>`, falling back to the files API or a local `git diff` beyond the 300-file limit.
  - Suppress `remote:` push banners.

### Also worth having (lower frequency)

- `pr stack` to show and retarget stacked PRs, and to report GitHub's automatic base changes (#3194 and #3195).
- `pr list --mine --mergeable` (from the "only my PRs" correction).
- Explicit `--repo` resolution that warns when the cwd's remote differs from the PR's repo.

---

## Appendix: artifacts

All artifacts are in this session's scratchpad (`/private/tmp/claude-501/-Users-benjaminjordan-projects-thegoldenmule-gh-for-agents/b8c4d8f6-eb2c-4414-b7a5-7dcb0c29c305/scratchpad/`):
- `extract.py` → `gh_calls.jsonl`: 1,677 records, including one from this session, with command, result, error flag and the next three gh commands.
- `inv.py`: subcommand, flag, `--json` field and jq inventory.
- `errs.py`: regex classification of error text.
- `bodies.py` → `writes.json`: PR create, edit, comment, merge and close calls with recovered titles and bodies, including bodies resolved from `--body-file` against earlier Write or heredoc calls.
- `flows.py`: episode, polling and output-handling statistics.
