# 07: ghx-eval, a deterministic measure of ghx against raw gh

This plan adds a dev-only tool that measures what ghx changes about an agent's GitHub work: turns, round trips, tokens, cost, errors and glue. It builds on [ghx-impact-findings.md](../research/ghx-impact-findings.md), which holds the evidence for every rule below. Read that first.

## Goal

One command turns a frozen set of transcripts into a report that compares ghx with raw gh on like-for-like work. Run it twice on the same inputs and the output is byte-identical. Change a metric definition and the report says so.

The tool answers two questions, in two tiers that share one metric core:

| Tier | Question | Input | Cost | Determinism |
|---|---|---|---|---|
| 1. Observe | What did ghx change in real sessions? | Transcripts on disk | $0 | Fully deterministic for a frozen corpus; observational, so confounded |
| 2. Oracle | What is the floor for each canonical question? | Scripted gh and ghx calls against the fake gh | $0 | Fully deterministic, no LLM |
| ~~3. A/B~~ | ~~What does an agent do with each, holding everything else fixed?~~ | ~~`claude -p` runs against a sandbox repo~~ | ~~$25–50 pilot~~ | Dropped 2026-10-29 (see M6) |

Tier 1 comes first because its input is disappearing (findings §0). Tier 2 is the cheapest clean answer. Without tier 3, nothing here separates ghx from the rest of the adoption bundle; every tier 1 report says so in its header.

## Status (2026-10-29)

M0–M5 are done and pushed. M6 is dropped. The first provisional report is manifest `13aa09e4bdb8` (see [How to run it](#how-to-run-it) and [the recency window](#the-recency-window)); its comparison with findings §4 is in [the findings' corrections](../research/ghx-impact-findings.md#corrections-2026-10-29-ghx-eval-m1m3).

## Non-goals

- Not a `ghx` subcommand. The command registry auto-discovers `src/commands/**` and `docs:gen` publishes every command to agents, so an eval command would appear in `ghx --help`.
- Not shipped in the npm package. It lives under `scripts/`, which is outside `files`.
- No telemetry leaves the machine.
- No new runtime dependencies. Bootstrap and rank tests are a few dozen lines.

## Layout

```
scripts/eval/
  cli.ts                 ghx-eval entry: snapshot | ingest | observe | oracle | report
  corpus/
    snapshot.ts          copy + manifest a corpus (M0)
    manifest.ts          path, size, mtime, sha256; manifest hash
    read.ts              stream JSONL to the last newline, record byte offsets
  model/
    records.ts           zod schemas for the record types in findings §1, tolerant of unknown fields
    dedupe.ts            the four dedupe rules (findings §1.2)
    session.ts           sessions, agents, turns, api_calls, tool_calls (§ Data model)
    usage.ts             context size, output recovery with out_src, advisor iterations
    pricing.ts           versioned price table
  classify/
    command.ts           gh / ghx / other + subcommand + glue flags, via src/hook/shell.ts
    intent.ts            intent priority (findings §3)
    errors.ts            exit codes, ghx error JSON, refusals, hook blocks
  units/
    episode.ts           intent episodes + glue
    wait.ts              background waits keyed by task id
    pr.ts                PR cycles (by head SHA) and PR lifecycles
  metrics/
    catalog.ts           METRIC_VERSION, constants, one function per metric
    stats.ts             median, p90, seeded bootstrap CI, Mann-Whitney U
  report/
    json.ts              report.json
    markdown.ts          report.md, generated from report.json only
  oracle/
    questions/<q>.ts     one canonical question per file (tier 2)
test/unit/eval-*.test.ts
test/fixtures/eval/      small, redacted JSONL fixtures with known answers
```

Run with `pnpm eval <subcommand>`. Reuse `scripts/acceptance/score.ts` for its background-wait and notification logic rather than writing a second parser; move shared pieces into `scripts/eval/model/` and have `score.ts` import them.

## Determinism contract

Every report carries enough to reproduce it. These are requirements, and each has a test.

1. **Frozen input.** A run reads a manifest, not a directory. The manifest lists path, size, mtime and sha256 for every file, plus a hash of the list. Files modified in the 6 hours before the snapshot are excluded and the cutoff is recorded.
2. **Own store.** `ingest` copies new and grown transcripts into `~/.ghx-eval/corpus/` incrementally, keyed by path and byte offset, so retention in `~/.claude` can't change a past report.
3. **Stable order.** Files sort by path, records by file order. Nothing iterates a `Map` built from filesystem order or depends on timestamps for structure.
4. **Versioned definitions.** `METRIC_VERSION`, every constant (c = 2.2, overhead 70, episode slack 0, gap 10 min, reference context 50k, rewrite threshold 0.5, rewrite minimum context 5,000, carry horizon 50) and the price table are emitted in `report.json`. Changing any of them bumps the version. METRIC_VERSION is 1.1.0 (see [Units](#units)).

   Corrections made during M2: episode slack is 0, not 3. `episodes/episodes.py` has no slack; 3 was the metrics prototype's `GAP_CALLS`, which counts API calls in another segmentation, and slack 3 gives 17% fewer episodes. `REWRITE_MIN_CTX = 5000` was added so a call on a near-empty context is not counted as a cache rewrite.
5. **Seeded statistics.** Bootstrap uses a fixed seed (42) and B = 1000, resampling sessions, not episodes.
6. **Explicit exclusions.** `<synthetic>` records, dev projects (this repo, spike directories) and files outside the manifest are counted in an `excluded` block, never dropped silently.
7. **Golden test.** A fixture corpus in `test/fixtures/eval/` produces a checked-in `report.json`; the test fails on any byte difference.

## Data model

Five tables, built per manifest and cached as JSONL next to it. `node:sqlite` works on Node 24.13 but is still experimental; start with JSONL and revisit if queries get slow.

| Table | Key | Main columns |
|---|---|---|
| sessions | session_id | project, cwd, version, entrypoint, first/last ts, title, n_compactions, pr_links, era (gh-pre, ghx-post, dogfood-dev, never-adopted) |
| agents | agent_id | session_id, parent_agent_id, spawn_tool_use_id, agent_type, request_shape, spawn_depth, model, is_fork |
| turns | turn_id | session_id, agent_id, starter_kind, is_human, start/end ts, interrupted |
| api_calls | message_id | session_id, agent_id, turn_id, model, ts, input, cache_read, cache_creation (1h/5m), context_tokens, output_tokens, out_src, advisor tokens, stop_reason, after_compaction |
| tool_calls | tool_use_id | message_id, agent_id, turn_id, name, command, cli, subcommand, run_in_background, call/result ts, is_error, exit_code, error_kind, result_bytes, persisted, background_task_id, notif ts/status/exit, output_file_read_bytes |

Column sources are in findings §1.

## Parsing rules that silently corrupt results if missed

Each one gets a unit test with a fixture built from a real record shape.

1. Group assistant records by `message.id` and take the last; summing records overcounts tokens 1.7–1.9×.
2. Dedupe `message.id` across files and prefer the non-fork file.
3. Subagent `output_tokens` with `stop_reason: null` are placeholders. Recover them from the next call's Δcontext minus the estimated result tokens, and record `out_src`.
4. Price advisor `iterations` separately with their own model.
5. Result size comes from `tool_result.content`, not `toolUseResult.stdout`.
6. A notification can appear three times; key by task id and take the earliest.
7. Bash exit codes come from `is_error` plus the `Exit code N` prefix; hook blocks, denials and validation errors are a separate `error_kind`.
8. For ghx, exits 10, 11 and 15 are outcomes, not errors. An error is a JSON `{"error":{"code"}}` body, even when a pipe turned the exit into 0.
9. `cost-state` is per process and resets on resume. Use it only as a cross-check on unresumed sessions.
10. Stop reading a live file at its last newline.

## What "turns" means

The request was "how many turns each one does". The report gives three numbers, because they measure different costs:

- **Human turns**: prompts a person typed (findings §1.4). Measures how often the user had to step in.
- **Round trips**: API calls (unique `message.id`) inside a unit. Measures the agent loop, and dominates cost.
- **Tool calls**: GitHub calls plus glue calls inside a unit. Measures how many steps a question took.

Wakeups (notifications that start a turn) are reported alongside round trips for wait units.

## Units

Units compose, from atomic to roll-up:

1. **Intent episode with continuations.** The atomic unit (findings §3). Background-wait episodes, notification-triggered calls and output-file reads attach to the episode that started them.
2. **PR cycle.** The waits and status reads on one PR between two head SHAs, as findings §3 defines it. Head SHAs come from `headRefOid` in gh output and `headSha` in ghx output; fall back to `git push` boundaries only when neither appears, and flag it.
3. **PR lifecycle.** One session and its subagents, one PR, create to merge. Unlike a cycle, a lifecycle takes every unit on the PR.
4. **Session.** GitHub's share of a session's calls and cost. Too few pure-ghx sessions exist for an arm comparison here; report shares by era instead.

**The post-wake rule (METRIC_VERSION 1.1.0).** After a background wait's notification wakes the agent, the wait keeps its glue (output-file reads, TaskOutput, TaskStop) and status reads or foreground waits on its own target. Any other GitHub call opens a new episode flagged `after-wake`, linked to the wait through `parent_unit_id`. Before 1.1.0, a merge or rerun made after a wake continued whichever episode was open when the wait launched; now that episode closes at the wake. The prototype's units went further and merged wait, wake and merge into one unit, so a findings "merge" corresponds to a ghx-eval merge episode plus its parent wait.

The wakeup counts in findings §4.4 disagree between wait-level and lifecycle-level. M2 resolves it by counting rounds by head SHA and reporting both levels.

## Metric catalog

Port `docs/research/ghx-impact/metrics/metric_catalog.json` (32 metrics) into `metrics/catalog.ts`. Each metric has an id, a unit, a formula, and a robustness flag.

- **Robust:** round trips, tool calls, GitHub invocations, glue calls, distinct commands, repeats, result tokens (`chars / 2.2 + 70`), cache rewrites, cost, `cost_norm`, errors, refusals, pipes, jq, sleep loops, `--watch`, background waits, Monitor scripts, notifications, human turns.
- **Proxy:** write tokens (allocated across parallel tool calls), recovered subagent output tokens, carry-forward cost (capped at 50 calls), retries, intent, wall-clock (it includes CI's own duration; report it, never optimise it).

`cost_norm` is the headline dollar figure (findings §2).

## Comparison rules

These are hard constraints in `report/`, not options.

- Never pool main threads with subagents. Their cache lifetimes differ (1h vs 5m) and flip the CI-wait result.
- Fix repo and model inside a comparison. Different models go in separate cells.
- Separate buckets: `gh-pre`, `ghx-post`, `gh-post` (raw gh after adoption), `dogfood-dev`, `never-adopted`.
- Cells with n < 5 are shown greyed with no CI and excluded from any summary line.
- Show medians and p90 with a 95% bootstrap CI and n in every cell. Means only as a secondary column.
- Every tier 1 report header states that pre/post measures the adoption bundle (ghx, hook, CLAUDE.md block, memory), not ghx alone, and names the dominant sessions when two or fewer hold more than half of a bucket.

## Tier 2: replay oracle

For each canonical question, script three answers and run each against the fake gh (`test/fixtures/bin/gh` with `GHX_FAKE_SCENARIO` and `GHX_FAKE_LOG`):

- the ghx call an agent should make,
- an expert gh call with `--json` and `--jq`,
- the typical gh sequence agents actually used (findings in `gh-usage-findings.md` §5 and the tier 1 episode examples).

Questions: PR status with CI, why CI failed (green, red, in-progress), wait for CI, rerun a flaky job, create a PR, merge a PR, read review feedback, main-branch health. Record new fake-gh scenarios read-only with `pnpm fixtures:record` where the existing ones don't cover a question.

Measure tool calls, GitHub API calls (from `GHX_FAKE_LOG`), bytes and estimated tokens returned, and whether the answer is correct. This is the floor each tool allows; tier 1 shows how far real agents are from it.

## Tier 3: dropped

M6 was dropped on 2026-10-29, by the user's decision. The evaluation works from the sessions already on disk: no sandbox repo, no `claude -p` A/B runs and no spend. The design notes for it are in findings §7 and in this file's history.

## ghx instrumentation (optional, opt-in)

Tier 1 infers ghx's behaviour from Bash commands. Two opt-in local logs would make it exact:

- **Hook log** (`GHX_HOOK_LOG=<path>`): the PreToolUse hook appends one NDJSON line per Bash or Monitor command it sees, raw gh included, with `session_id`, `cwd`, the command, and the hook's decision. It is the only place that sees both arms with a session id.
- **Invocation log** (`GHX_LOG=<path>`): a ProcessRunner decorator, modelled on `src/proc/recording.ts`, records each ghx invocation's command, exit code, duration, output bytes and the gh calls behind it.

Both are off by default, write only locally, and are joined to transcripts on `session_id`, falling back to cwd plus timestamp.

## Milestones

Each milestone lands as its own commits with tests and passes `pnpm check`.

| M | Deliverable | Done when | Status |
|---|---|---|---|
| M0 | `snapshot` and `ingest`: manifest, incremental copy to `~/.ghx-eval/corpus/`. Import the 2026-10-29 archive. | Two snapshots of an unchanged corpus produce the same manifest hash | Done |
| M1 | `model/` and `classify/`: the five tables, all ten parsing rules | Each rule has a fixture test; token totals for one unresumed main session match its `cost-state` within 2% | Done |
| M2 | `units/` and `metrics/`: episodes, waits, PR cycles and lifecycles, the catalog | Episode counts within 3% of the Python prototype on the 2026-10-29 snapshot | Done, with episode slack 0 |
| M3 | `report/` and `observe`: report.json and report.md | Golden test passes; findings §4 tables reproduce from the snapshot | Done. The tables are produced; where their numbers differ from §4, the cause is a definition, listed in the findings' corrections |
| M4 | Tier 2 oracle with 8 questions | Every question answered correctly by the ghx and expert-gh scripts | Done, with 10 questions |
| M5 | Hook and invocation logs in ghx | Off by default; a session with both on joins every ghx call to its tool_use | Done (`GHX_HOOK_LOG`, `GHX_LOG`) |
| ~~M6~~ | ~~Tier 3 pilot~~ | ~~36 runs, per-arm report, cost within budget~~ | Dropped 2026-10-29 |

M0 was urgent because the gh-era baseline lost a day of history every day. The store now holds every transcript from the 2026-10-29 archive on, so retention in `~/.claude` no longer changes a report. Keep ingesting to capture new sessions.

## Open check that shaped M5

The open checks before M6 went with it, except one. Does the Bash environment expose a session id the hook log can record? Yes: `CLAUDE_CODE_SESSION_ID` is in the Bash environment and holds the root session id, and the hook's stdin carries `session_id` and `tool_use_id`. M5 is built on that: `GHX_LOG` records the session id, `GHX_HOOK_LOG` records the tool_use_id, and `src/hook/join.ts` joins the two.

## How to run it

Every subcommand prints `--help`. Observe needs about 1.7 GB of memory; run one at a time. Check free disk before an ingest: the store holds a copy of every transcript.

```sh
# 1. Copy new and grown transcripts from ~/.claude/projects into ~/.ghx-eval/corpus/files.
pnpm eval ingest --no-manifest --label "<why>"

# 2. Freeze the store into a manifest. The default 6-hour window drops files modified recently;
#    --window-hours 0 keeps them (see "The recency window").
pnpm eval snapshot --store ~/.ghx-eval/corpus --window-hours 0 \
  --out ~/.ghx-eval/corpus/manifests/$(date -u +%Y%m%dT%H%M%SZ).json

# 3. Tier 1. Writes report.json and report.md; --baseline reports any definition change since that report.
pnpm eval observe --manifest ~/.ghx-eval/corpus/manifests/<stamp>.json \
  --out ~/.ghx-eval/reports/<hash12> --baseline ~/.ghx-eval/reports/5aef2a686ca7/report.json

# 4. Re-render report.md from report.json, optionally against a baseline.
pnpm eval report --in ~/.ghx-eval/reports/<hash12>/report.json --baseline <earlier report.json>

# 5. Tier 2.
pnpm eval oracle --out ~/.ghx-eval/reports/<hash12>/oracle.json --md ~/.ghx-eval/reports/<hash12>/oracle.md
```

Observe caches its tables next to the manifest, in `<manifest>.tables/<key>/`. The cache is derived: delete a directory whose `key.json` names an older tables schema. Reports stay under `~/.ghx-eval/`, never in the repo.

| Manifest | Hash | Files | Window | Use |
|---|---|---|---|---|
| `20261029T155633Z.json` | `5aef2a686ca7…` | 2,909 | 6 h | Frozen baseline. Excludes the main transcripts of the two dominant sessions |
| `20261029T171259Z.json` | `13aa09e4bdb8…` | 3,031 | 0 h | Provisional prefix snapshot. Includes them |

## The recency window

Snapshots exclude files modified in the 6 hours before the cutoff, so a half-written file never enters a manifest. Long-running sessions pay for it: the main transcripts of powerhouse sessions `3c2fb48f` and `f4543194` were still being written on 2026-10-29, so the 6-hour window dropped them while keeping their subagent files. The two sessions hold most of the ghx era. Without their main threads, the 5aef2a686ca7 report has 1 ghx main-thread merge against 20 in the prefix snapshot, and no ghx created-and-merged lifecycle in a main thread.

For a provisional report, ingest and snapshot the store with `--window-hours 0`. This is safe because a manifest records each file's size and sha256, and observe reads each file only up to that size and checks the hash. Store files that grow later leave the report unchanged. On 2026-10-29, observe ran twice on `13aa09e4bdb8`, once uncached after a second ingest had grown five of its files; both report.json and report.md were byte-identical. Re-snapshot once the sessions close, and treat the later report as the one of record.

## Follow-ups for ghx itself

Findings §4 and §5 pointed at product work, to be confirmed by M3 before acting. Figures below are from the provisional report `13aa09e4bdb8` (powerhouse, claude-opus-5-5, gh-pre → ghx-post, medians) and the oracle run beside it. Error-code and output-file counts are taken from its tables over every repo except this one.

- **Confirmed: `pr create` and `pr edit` validation.** 50% of ghx create episodes and 47% of edit episodes hit an error (58% of creates in the 5aef2a686ca7 baseline), against 2–6% with gh. `VALIDATION` is still the top ghx error code (34). In subagents, a create costs 3 tool calls against 1 and $0.085 against $0.053. A shorter error hint or a smaller `ghx schema pr create` view is still the fix to try first.
- **Confirmed: unknown commands.** 23 `USAGE_UNKNOWN_COMMAND` errors, the same agents guessing gh's shape. Aliases or hints that name the ghx equivalent would turn each into one call.
- **Confirmed: the `ci wait` notification carries no result.** 155 of 182 background `ci wait` calls (85%) are followed by a read of the output file. A summary line in the notification would save that call.
- **Refined: subagent waits.** A background `ghx ci wait` costs $0.296 per wait in a subagent (0.70 cache rewrites) against $0.075 in a main thread (none). A gh background loop costs the same in a subagent ($0.294, 0.65 rewrites), so the cost comes from the 5-minute cache, not from ghx. A foreground sleep loop in a subagent costs $0.062. Guidance for subagents may still need to differ from main threads.
- **Confirmed and larger: result size.** Subagent status reads return 2,558 characters against 620. The oracle shows the floor: ghx returns 3.5× the bytes of an expert gh call overall, from 0.8× (ci rerun) to 45× (ci why on a green run), and `pr status` returns 6,850 bytes against 199. ghx answers all ten questions in 12 tool calls against 19, so the bytes buy fewer calls. Check whether `--brief` should be the default for status reads, or whether `pr status` carries more than an agent needs.
- **New: diagnosis in subagents is the clearest win.** Tool calls 2 → 1, result characters 3,954 → 988, cost_norm $0.113 → $0.060 (p < 0.001).
- **Smaller than reported: main-thread merges.** Findings' 6 → 2 round trips and $0.267 → $0.110 does not reproduce under ghx-eval's definitions; see the findings' corrections.
