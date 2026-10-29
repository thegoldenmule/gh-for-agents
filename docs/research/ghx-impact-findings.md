# Measuring ghx against raw gh: findings from the transcript corpus

Research input for [07-ghx-eval.md](../plans/07-ghx-eval.md). Four research agents went over every Claude Code transcript on this machine on 2026-10-29. One mapped the transcript schema, one designed the episode taxonomy, one designed the token and cost metrics, and one checked how a tool would fit this repo and whether a controlled A/B run is feasible. Their prototype scripts and generated reports are in [ghx-impact/](ghx-impact/). They are Python reference code for the TypeScript port in plan 07, and are not maintained.

## Corrections (2026-10-29, ghx-eval M1–M3)

The TypeScript port in `scripts/eval` (plan 07) re-measured this corpus. The sections below stand as written, except §1.4, whose swap is fixed in place. Where ghx-eval disagrees, this section says why.

### Errors and definitions

- **§1.4 swapped two counts.** task_notification is 924 and peer is 927 (M1, on the 2026-10-29 archive). The prefix snapshot below counts 942 and 941; the two are within 1% of each other either way.
- **§1.5 hook blocks.** M1 counts 7 blocking hook errors plus 3 `ask` nudges, not 16.
- **§3 slack.** `episodes/episodes.py`, which produced §4.1, has no slack: an episode closes at the first tool call that is neither GitHub nor glue. "A slack of 3" was the metrics prototype's `GAP_CALLS`, which counts non-GitHub API calls in a separate segmentation (`metrics/episodes.py`). §4.2–§4.4 come from that segmentation. ghx-eval uses slack 0; slack 3 gives 17% fewer episodes.
- **§4.2–§4.4 units differ from ghx-eval's.** `metrics/units.py` joined every episode that continued a wait (through its notification or output-file read) into one unit, transitively. A "merge" unit there holds the wait, the wake, the merge and any earlier waits in the chain: a main-thread background `ghx ci wait` unit carried 3.1 notifications on median. ghx-eval keeps a wait to the calls about it and opens an `after-wake` episode, linked through `parent_unit_id`, for the next other GitHub call (METRIC_VERSION 1.1.0). §4.4's rounds were counted by pushes; ghx-eval counts them by head SHA.
- **§4 ran without the dominant sessions' main threads, in ghx-eval's first report.** The frozen manifest `5aef2a686ca7` (2026-10-29 15:56Z, 6-hour window) excluded the main transcripts of `3c2fb48f` and `f4543194`, which were still being written, while keeping their subagents. The two sessions hold 88–90% of ghx-era units. The provisional prefix snapshot `13aa09e4bdb8` (17:12Z, `--window-hours 0`, 3,031 files) includes them, read up to the size its manifest records. gh-pre is identical in both (684 units).

### Fresh comparison

Powerhouse, gh-pre → ghx-post. "Baseline" is report `5aef2a686ca7`; "prefix" is report `13aa09e4bdb8`. ° marks n < 5.

**§4.1, by intent.** Episodes and background waits, main and subagent pooled, all models, as §4.1 pooled them. Median tool calls, median result characters, share with an error.

| Intent | Findings n | Findings calls | Findings chars | Prefix n | Prefix calls | Prefix chars | Prefix with error | Baseline n (ghx) |
|---|---|---|---|---|---|---|---|---|
| Diagnose | 131 / 42 | 3 → 2 | 4,115 → 1,842 | 144 / 42 | 3 → 1.5 | 3,940 → 1,597 | 10% → 19% | 39 |
| Status | 186 / 110 | 1 → 1 | 528 → 1,759 | 173 / 107 | 1 → 1 | 613 → 2,078 | 2% → 11% | 84 |
| Wait | 118 / 183 | 1 → 2 | 1,102 → 1,894 | 126 / 188 | 2 → 2 | 486 → 1,070 | 8% → 11% | 169 |
| Create | 44 / 37 | 1 → 3 | 134 → 5,634 | 49 / 38 | 1 → 3 | 130 → 5,635 | 2% → 50% | 33 |
| Edit | 29 / 17 | 1 → 3 | | 32 / 17 | 1 → 3 | 238 → 6,158 | 6% → 47% | 17 |
| Merge | 35 / 29 | 2 → 2 | 171 → 913 | 38 / 31 | 1 → 2 | 78 → 913 | 3% → 10% | 12 |
| Rerun | 15 / 21 | 1 → 2 | | 24 / 23 | 1 → 1 | 114 → 624 | 4% → 30% | 23 |

The direction holds for every intent except wait calls, where ghx-eval counts 2 for a gh wait against §4.1's 1. Classification moves the gh-side counts by −7% to +11%, and reruns by +60%. The ghx-side counts match §4.1 within 10% once the dominant sessions' main threads are in.

**§4.2, by unit and context.** claude-opus-5-5 only, as the report fixes the model. GitHub round trips and cost_norm, medians.

| Category | Context | Findings | Baseline | Prefix |
|---|---|---|---|---|
| merge | main | 8 / 15: 6 → 2, $0.267 → $0.110 | 20 / 1°: 2 → 2°, $0.053 → $0.050° | 20 / 20: 2 → 1, $0.053 → $0.054 (p 0.60) |
| merge + its wait | main | (as above) | 18 / 1°: 3 → 3°, $0.086 → $0.110° | 18 / 20: 3 → 2, $0.086 → $0.069 |
| ci-diagnose | main | 41 / 5: 5 → 4, $0.26 → $0.35 | 59 / 7: 3 → 2, $0.097 → $0.102 | 59 / 9: 3 → 3, $0.097 → $0.096 |
| ci-diagnose | subagent | 53 / 20: 4 → 5, $0.18 → $0.16 | 76 / 32: 2 → 1, $0.113 → $0.063 | 76 / 33: 2 → 1, $0.113 → $0.060 (p < 0.001) |
| pr-write (create) | subagent | 1 → 6, $0.062 → $0.528, errors 0.14 → 0.81 | 21 / 33: 1 → 3, $0.053 → $0.092, errors 0.05 → 0.76 | 21 / 38: 1 → 2, $0.053 → $0.085, errors 0.05 → 0.66 |
| pr-write (edit) | subagent | (pooled with create) | 16 / 13: 1 → 2, $0.062 → $0.125 | 16 / 13: 1 → 2, $0.062 → $0.125 |
| ci-status | subagent | result tokens 708 → 1,582 | 363 → 1,180 | 363 → 1,233 |
| PR cycle | main | 4 → 2, $0.275 → $0.121 | 61 / 5: 2 → 2, $0.131 → $0.399 | 61 / 22: 2 → 2, $0.131 → $0.113 (p 0.51) |
| PR cycle | subagent | 2 → 3, $0.115 → $0.312 | 77 / 113: 2 → 1, $0.128 → $0.334 | 77 / 124: 2 → 1, $0.128 → $0.335 (p < 0.001) |

"Merge + its wait" joins a merge episode to the wait whose wake it followed, as one span with each API call counted once. It is an ad hoc view, not in the report. Summing the two units' metrics instead gives the same round trips and cost_norm within $0.01.

**The main-thread merge headline does not reproduce under ghx-eval's definitions.** A merge episode alone goes 2 → 1 GitHub round trips at the same cost. A merge plus its wait goes 3 → 2 and $0.086 → $0.069. The headline's shape comes back only under the prototype's segmentation. With slack 3 and waits chained through their wakes, gh-era merges grow to 6 round trips (5 GitHub round trips), 12 gh invocations and $0.228 (n 13, all models), against 2 round trips and $0.071 for ghx (n 20). So the gap came from the gh side: the prototype folded the surrounding work into gh-era merge units (non-GitHub calls, chained waits, sleep loops, 6.4 pipes per unit). The ghx side is 2 round trips under every definition. Its 20 merges come from 2 sessions, and 19 of them are in the main transcripts the 6-hour window dropped.

**§4.3, waits by mechanism.** Findings pooled all non-dogfood repos and models; ghx-eval rows are powerhouse and claude-opus-5-5. n, cost_norm per wait (median), cache rewrites per wait (mean).

| Mechanism | Context | Findings | Prefix |
|---|---|---|---|
| background `ghx ci wait` | main | 9, $0.211, 0 | 29, $0.075, 0 (baseline 20, $0.078) |
| background gh loop | main | 16, $0.259, 0 | 20, $0.086, 0.10 |
| Monitor | main | 15, $0.267, 0.07 | 13, $0.088, 0 |
| background `ghx ci wait` | subagent | 71, $0.468, 1.83 | 155, $0.296, 0.70 (baseline 145, $0.293) |
| background gh loop | subagent | 22, $0.387, 1.77 | 46, $0.294, 0.65 |
| Monitor | subagent | 21, $0.517, 1.24 | 12, $0.173, 0.50 |
| foreground sleep loop | subagent | 37, $0.095, 0.51 | 23, $0.062, 0.17 |

ghx-eval's waits are smaller and cheaper because a prototype wait unit was a chain of waits with their continuations (median 11 API calls against 4). Adding each wait's after-wake episodes back changes little: a main-thread `ghx ci wait` moves from $0.074 to $0.077. The ordering survives in subagents: any background wait there costs 3–4× a main-thread one and pays a cache rewrite on most wakes, with ghx and a gh loop alike.

**§4.4, created and merged in one session.** Pooled contexts and models, as in §4.4, then the report's split for claude-opus-5-5. Medians.

| | Findings gh (28) | Findings ghx (24) | Prefix gh (28) | Prefix ghx (27) | Baseline ghx (10) |
|---|---|---|---|---|---|
| GitHub calls | 13 | 17.5 | 13.5 | 16 | 19.5 |
| Result chars | 16k | 19.8k | 16.4k | 22.9k | 35.4k |
| Wakeups | 1.5 | 3.5 | 2 | 4 | 5.5 |
| CI rounds (head SHA) | | | 3.5 | 3 | 3 |
| Elapsed | 4.2 h | 1.6 h | 4.2 h | 1.6 h | 4.3 h |
| Round trips | | | 16.5 | 20 | 26.5 |
| cost_norm | | | $0.85 | $1.14 | $6.21 |

Split by context in the prefix report: main threads (17 / 21) go 6 → 2 CI rounds, 17 → 19 round trips and $0.881 → $0.686 (p 0.77); subagents (10 / 6) stay at 3 rounds and go 14 → 26.5 round trips and $1.06 → $6.21 (p 0.008). The baseline has no ghx lifecycle in a main thread at all. The gh side matches §4.4; the ghx side matches it only once the dominant sessions' main threads are in.

## 0. TL;DR

- **The data is perishable.** The corpus runs from 2026-09-22 to 2026-10-29 because Claude Code deletes transcripts after 30 days. The raw-gh baseline in powerhouse (before 2026-10-23) is already losing a day of history every day, and is gone from `~/.claude/projects` by about 2026-11-22. A compressed snapshot is at `~/.ghx-eval/corpus/claude-projects-2026-10-29.tar.gz` (470 MB, 2,965 files, sha256 `2ab9b3f08d8b7d0f…`). The JSONL manifest hash for the same corpus is `8f5cd43a…` (1,394 transcripts, 1.88 GB).
- **Naive token sums are wrong by up to 1.9×.** One API response is split over several transcript records, one per content block, and each record repeats the usage. Subagent `output_tokens` are stream-start placeholders in 91% of calls.
- **Only one repo has a before and after.** powerhouse got `.github/ghx.json` on 2026-10-23. The ghx era is 7 sessions, and two of them hold 89% of its episodes. Every number below is preliminary.
- **Where ghx wins so far:** merges (main thread: 6 → 2 round trips, $0.27 → $0.11 normalized), CI diagnosis (pipes per episode 4.9 → 1.4, result size halved), refusals (≈0 after adoption), and main-thread CI waits (4 → 2 round trips per PR, $0.28 → $0.12).
- **Where ghx loses so far:** PR writes in subagents (1 → 6 round trips, $0.06 → $0.53, 19 of 37 first `pr create` attempts fail `VALIDATION`), CI waits in subagents (background waits idle past the 5-minute cache and pay for a full rewrite on wake), and status reads (results about 3× larger).

## 1. Transcript data model

### 1.1 Layout

```
~/.claude/projects/<cwd-slug>/<sessionId>.jsonl                               main thread (95)
  <sessionId>/subagents/agent-<agentId>.jsonl + agent-<agentId>.meta.json     every depth, flat (1,298)
  <sessionId>/subagents/agent-<id>.forked-skill{,.marker}.json                skill forks (135)
  <sessionId>/tool-results/*.txt                                              persisted large outputs
```

- Every subagent record carries the root `sessionId`, its own `agentId` and `isSidechain: true`.
- `meta.json` holds `agentType`, `description`, `toolUseId`, `parentAgentId`, `spawnDepth`, `requestShape` (background or foreground), `model` and `isFork`.
- `meta.toolUseId` is the `id` of the parent's `Agent` tool_use (1,120 of 1,126 resolve). When `parentAgentId` disagrees with the file that holds the tool_use, trust the file.
- Skill forks have no `toolUseId`. Link them through the Skill tool result, whose `toolUseResult` has `status: "forked"` and the `agentId`.
- `sessions-index.json` is stale: all 155 entries point to deleted files.

### 1.2 Records that must be deduplicated

| Duplicate | Cause | Rule |
|---|---|---|
| Assistant records | One record per content block, same `message.id` and `requestId`, usage repeated | Group by `message.id`, take the last record in file order |
| Forked history | A fork copies its parent's records (same `message.id`; from a subagent, same uuids too) | Dedupe `message.id` across files, prefer the non-fork file |
| Task notifications | The same notification appears as a `queue-operation`, an `attachment.queued_command` and a `user` record | Key by task id, take the earliest timestamp |
| Metadata records | `ai-title`, `cost-state`, `mode` and others are re-appended without timestamps | Take the last one |

### 1.3 Usage

- `message.usage` has `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens` and `service_tier`. Some records add `iterations[]`, `server_tool_use` and `output_tokens_details.thinking_tokens`.
- Top-level usage is the sum of `iterations[type=message]`. Advisor calls (claude-fable-5-1) appear only in `iterations[type=advisor_message]` and must be priced separately.
- Context size for a call is the last `message` iteration's `input + cache_creation + cache_read`.
- **Subagent output tokens are placeholders.** 22,458 of 24,600 subagent calls (and 3 of 7,673 main-thread calls) end on a `tool_use` with `stop_reason: null`. Their usage is a stream-start snapshot: input fields are final, `output_tokens` is about 2% of the true value. Thinking text is redacted, so it can't be counted from content.
- `<synthetic>` model records (163) are API errors. Exclude them.
- **`cost-state` is not ground truth.** It is cumulative per process and resets on resume: one session recorded $306 against $649 computed from usage. Use it as a sanity check on unresumed sessions only.

### 1.4 Turns

- **Human prompt:** in a main file, `type == "user"`, not `isMeta`, not `isCompactSummary`, content not all `tool_result`, and `origin.kind == "human"` or `promptSource` in {typed, suggestion_accepted, queued}. Exclude content starting with `<command-name>`, `<local-command-` or `[Request interrupted`.
- **Main-thread turn:** all records sharing a `promptId`. Classify it by its starter: human 543, task_notification 924, peer (subagent hand-backs) 927, sdk 21, auto_continuation 15, scheduled 5.
- **Subagent turn:** `promptId` changes at each tool result there, so split on non-tool-result user records instead.
- `turn_duration.durationMs` is missing for about half of turns. Compute duration from timestamps.

### 1.5 Tool calls

- A `tool_use` block is `{id, name, input}`. Bash input has `command`, `description`, `timeout` and `run_in_background`. The command recorded is the one before any PreToolUse hook rewrite.
- The matching `tool_result` has the same `tool_use_id` in the same file.
- **Bash has no exit-code field.** Errors set `is_error: true` and the content starts with `Exit code N`. 422 of 1,645 errors are something else: permission denials, input validation, and hook blocks. The ghx PreToolUse hook blocked raw gh 16 times.
- **Measure result size from `tool_result.content`**, not `toolUseResult.stdout`. For persisted outputs the model saw a 2 KB preview while `stdout` holds up to 30 KB.
- **Background output never reaches the transcript.** A background Bash call returns a placeholder. Completion arrives as a task notification with `<tool-use-id>`, `<status>` and `(exit code N)` in its summary. The model sees the output only if it reads the `<output-file>`, which lives under `/private/tmp` and is deleted later. 1,650 of 1,743 background Bash calls got a notification.

### 1.6 Time, models and compaction

- All records with content carry an ISO-8601 UTC `timestamp`. File order isn't strictly chronological (5,281 backward steps), so use file order or `parentUuid` for structure and timestamps only for durations.
- Foreground Bash wall-clock (result − call): p50 0.7 s, p90 4.9 s. `ghx ci wait` launch-to-notification: p50 about 21 minutes (n = 176). That is CI's duration, not the agent's cost.
- Models by API call: opus-5-5 161.6k, sonnet-5 10.5k, fable-5-1 3.8k, haiku-4-5 168. Claude Code versions: 2.1.258 and 2.1.280.
- Compaction is a `system/compact_boundary` record with `compactMetadata{trigger, preTokens, postTokens}`, followed by a user record with `isCompactSummary`. The summarization call itself isn't in the transcript. There are 10 in the corpus. Treat each as a context reset.
- Four main files were still being written during the survey. A reader must stop at the last newline and record the byte offset.

## 2. Token attribution

Tokens are reported per API call, not per tool call. The metrics agent tested three ways to charge a gh or ghx call:

| Method | What it measures | Deterministic | Use |
|---|---|---|---|
| (a) Output tokens of the response that emitted the call, split across its tool calls by input size | Writing the command, plus thinking | Main threads yes; subagents need recovery | `write_tok` |
| (b) Result size as `chars / 2.2 + 70` tokens | Context added by the result | Yes | **Primary**: `res_tok_est` |
| (b′) Measured Δcontext between the calls before and after | Same, measured | Only on clean calls (~60%) | Validation only |
| (c) Carry-forward: (result + emitted output) × calls left before compaction or end | Re-reading the result on later calls | Yes, but dominated by unrelated later work | Secondary, capped at 50 calls |

- On clean main-thread calls, Δcontext = 85 + 0.96 × output + chars / c, with c = 2.10 for gh, 2.30 for ghx and 2.25 for other Bash. R² is 0.79–0.95, the median relative error 9%. The output coefficient near 1.0 means thinking stays in context.
- **Recovering subagent output tokens:** out = Δcontext(next call) − Σ result estimates, used when it is at least half the visible-character estimate, else visible chars / 2.2. Median relative error is 7% on the 1,099 subagent calls that do have final usage, with a +14% aggregate bias. Every call records its provenance in `out_src` (final, recovered or visible_est).
- **Headline cost is `cost_norm`.** The cost of a round trip is dominated by context size × cache-read price, and session context differs between arms. `cost_norm` = Σ over the episode's calls of [output cost + input cost × (ctx − C0 + 50k) / ctx], where C0 is the context at the episode's start. It keeps the episode's own growth and any cache rewrites but replaces the session's base context with 50k.
- **Pricing** (per MTok, input / output / cache read): opus-5-5 $4 / $20 / $0.20, opus-5 $5 / $25 / $0.50, sonnet-5 $2 / $10 / $0.20, fable-5-1 $10 / $50 / $0.25, haiku-4-5 $1 / $5 / $0.10. Cache writes cost 1.25× input (5m) or 2× input (1h). This reproduces `cost-state` exactly for a Fable session and within 2% for an unresumed Opus session.
- **Cache lifetime splits main threads from subagents.** Main threads use the 1h cache and subagents the 5m cache: after an idle gap past that, about 93% of the context is rewritten. One rewrite costs about 25 cache-read round trips at 5m, or 40 at 1h.

## 3. Units of comparison

Comparing "sessions with ghx" to "sessions with gh" is meaningless because sessions do different work. Two proposals came back, and they compose:

- **Intent episode** (atomic). A run of gh or ghx calls in one transcript file, plus the glue that processes their output (reads of redirect targets, `logPath` files and background output files, bare `sleep`, and a Write whose file is then passed as `--input` or `--body-file`). It closes at any other tool call after a slack of 3, a human prompt, a compaction, or a gap over 10 minutes. Gaps of 5, 10 and 30 minutes give 1,457, 1,439 and 1,412 episodes, so the choice barely matters.
- **Background waits** (`ci wait`, Monitor, background loops) are their own episode keyed by task id. They close at the terminal notification or a TaskStop, and later reads of the output file attach to them.
- **Intent** is the highest-priority match in: merge, create, edit, reply, other_write, diagnose, rerun, wait, feedback, status, other_read, meta. A status read inside a sleep loop, background Bash or Monitor counts as wait.
- **PR cycle**: all waits and status reads on one PR between two head SHAs.
- **PR lifecycle**: one session (with its subagents) and one PR, from create to merge.

Known segmentation failures: 749 episodes end at a non-GitHub Bash call such as `git push`; compound commands mix git, gh and file reads; 75 episodes (5%) span several PRs; 571 name only run ids or branches and are charged to the last PR named; gh-era foreground polling lands in status rather than wait.

## 4. Preliminary results (powerhouse, before vs after 2026-10-23)

These compare the adoption bundle, not ghx alone: ghx, its PreToolUse hook, the CLAUDE.md block and the no-sleep memory all arrived on the same day. The ghx era is 7 sessions (two hold 89% of its episodes), 82% of its units run in subagents against 57% before, and it is all opus-5-5 while the gh era includes 26 Fable and 3 Sonnet units.

### 4.1 By intent (episode medians, p90 in brackets)

| Intent | n gh / ghx | Calls | Result chars | Note |
|---|---|---|---|---|
| Diagnose | 131 / 42 | 3 [6] → 2 [5] | 4,115 [17,466] → 1,842 [9,097] | 21% of ghx episodes hit an error |
| Status | 186 / 110 | 1 → 1 | 528 → 1,759 | |
| Wait | 118 / 183 | 1 → 2 | 1,102 → 1,894 | ghx's second call reads the output file |
| Create | 44 / 37 | 1 → 3 | 134 → 5,634 | 19 of 37 first attempts fail `VALIDATION` |
| Edit | 29 / 17 | 1 → 3 | | 47% of ghx edits hit an error |
| Merge | 35 / 29 | 2 → 2 | 171 → 913 | p90 wall-clock 410 s → 34 s |
| Rerun | 15 / 21 | 1 → 2 | | 33% of ghx reruns hit an error |

### 4.2 By unit, split by context (round trips and `cost_norm`, medians)

| Category | Context | n gh / ghx | Round trips | cost_norm | Other |
|---|---|---|---|---|---|
| merge | main | 8 / 15 | 6 → 2 | $0.267 → $0.110 | pipes 6.4 → 0.3 |
| ci-diagnose | main | 41 / 5 | 5 → 4 | $0.26 → $0.35 (CI very wide) | pipes 4.9 → 1.4 |
| ci-diagnose | subagent | 53 / 20 | 4 → 5 | $0.18 → $0.16 | refusals 0.19 → 0, errors 0.38 → 0.10 |
| pr-write | subagent | | 1 → 6 | $0.062 → $0.528 | errors 0.14 → 0.81 |
| ci-status | both | | ≈ | ≈ | result tokens 708 → 1,582 (subagent) |
| PR cycle | main | | 4 → 2 | $0.275 → $0.121 | |
| PR cycle | subagent | | 2 → 3 | $0.115 → $0.312 | median 1 cache rewrite |

### 4.3 Waiting for CI, by mechanism (all repos)

| Mechanism | Context | n | cost_norm per wait | Cache rewrites |
|---|---|---|---|---|
| background `ghx ci wait` | main | 9 | $0.211 | 0 |
| background gh loop | main | 16 | $0.259 | 0 |
| Monitor | main | 15 | $0.267 | 0.07 |
| background `ghx ci wait` | subagent | 71 | $0.468 | 1.83 |
| background gh loop | subagent | 22 | $0.387 | 1.77 |
| Monitor | subagent | 21 | $0.517 | 1.24 |
| foreground sleep loop | subagent | 37 | $0.095 per fragment | 0.51 |

In a main thread, a background `ghx ci wait` is the cheapest way to wait. In a subagent, any wait that idles past 5 minutes pays a cache rewrite on wake, so it can cost more than polling at intervals under 5 minutes.

### 4.4 Whole PR lifecycle (created and merged in one session)

| | raw gh (28) | ghx (24) |
|---|---|---|
| GitHub calls | 13 | 17.5 |
| Result chars | 16k | 19.8k |
| Wakeups | 1.5 | 3.5 |
| Elapsed | 4.2 h | 1.6 h |

Wakeups per background wait (p90) are 1.0 with ghx against 3.4 with gh, yet wakeups per lifecycle go the other way. The count depends on how rounds are defined; plan 07 counts rounds by head SHA to settle it.

## 5. ghx friction seen in the data

- Error codes: `VALIDATION` 32, `USAGE_UNKNOWN_COMMAND` 23, `USAGE_UNKNOWN_FLAG` 5, `RUN_IN_PROGRESS` 5. No exit-6 policy refusals.
- Unknown commands are agents guessing gh's shape: `ghx pr view` (9+), `ghx run view --log`, `ghx ci logs`, `ghx pr ready`.
- Many errors came back with exit 0, because agents still pipe ghx output.
- After a ghx error the next GitHub call within 10 minutes was never raw gh: ghx with the same intent 50 times, another intent 21, nothing 5.
- 73 meta calls (`--help`, `schema`, `doctor`). `ghx schema pr create` alone returns about 12.5k characters.
- 166 reads of `ci wait` output files, because the notification carries no payload. 25 commands polled a `ci wait` that was still running.
- Unquoted `--fields a[].b` hit zsh's "no matches found" 3 times.
- After adoption, 15 raw gh calls ran in powerhouse: 10 read other repos, 3 were nudged or denied by the hook, 2 ran unchallenged.

## 6. Fit with this repo

- `scripts/acceptance/score.ts` already parses session JSONL and scores CI waits, calls-to-diagnose, end-to-end calls, raw gh use and refusals. `src/hook/shell.ts` already exports `scanShell`, `isGh`, `isGhx` and `isCiWait`.
- `test/fixtures/bin/gh` is a fake gh that replays a scenario and logs each argv to `GHX_FAKE_LOG`. `scripts/fixtures/record.ts` records new scenarios read-only.
- ghx logs nothing about its own invocations today. `ProcResult.durationMs` exists, and `src/proc/recording.ts` shows how a ProcessRunner decorator can observe every gh call.
- `node:sqlite` loads on the pinned Node 24.13 with an experimental warning.

## 7. Controlled runs (`claude -p`)

- The result message reports `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd` (a client estimate that includes subagents), `usage` (main loop only), `modelUsage`, `permission_denials` and `structured_output`. `system/init` lists the model, tools, MCP servers and plugins, so each arm's setup can be checked.
- `--settings` adds to the user's settings rather than replacing them, and the ghx hook runs by absolute path. Hiding ghx from PATH isn't enough; each arm needs its own `CLAUDE_CONFIG_DIR`. That drops the claude.ai login, so runs need `ANTHROPIC_API_KEY` or a `setup-token` token.
- Don't use `--bare`: from 2.1.286 it turns off background tasks, which breaks `ghx ci wait`.
- Cost on opus-5-5 is about $0.04–0.05 per step, or $0.5–2 per task run. A 36-run pilot is about $25–50.
- Organization managed settings ("pipe through tail -50") apply to both arms and push agents toward the piping ghx is measured against.
