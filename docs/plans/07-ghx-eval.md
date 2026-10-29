# 07: ghx-eval, a deterministic measure of ghx against raw gh

This plan adds a dev-only tool that measures what ghx changes about an agent's GitHub work: turns, round trips, tokens, cost, errors and glue. It builds on [ghx-impact-findings.md](../research/ghx-impact-findings.md), which holds the evidence for every rule below. Read that first.

## Goal

One command turns a frozen set of transcripts into a report that compares ghx with raw gh on like-for-like work. Run it twice on the same inputs and the output is byte-identical. Change a metric definition and the report says so.

The tool answers three questions, in three tiers that share one metric core:

| Tier | Question | Input | Cost | Determinism |
|---|---|---|---|---|
| 1. Observe | What did ghx change in real sessions? | Transcripts on disk | $0 | Fully deterministic for a frozen corpus; observational, so confounded |
| 2. Oracle | What is the floor for each canonical question? | Scripted gh and ghx calls against the fake gh | $0 | Fully deterministic, no LLM |
| 3. A/B | What does an agent do with each, holding everything else fixed? | `claude -p` runs against a sandbox repo | $25–50 pilot | Deterministic analysis of nondeterministic runs; needs repetitions |

Tier 1 comes first because its input is disappearing (findings §0). Tier 2 is the cheapest clean answer. Tier 3 is the only one that separates ghx from the rest of the adoption bundle.

## Non-goals

- Not a `ghx` subcommand. The command registry auto-discovers `src/commands/**` and `docs:gen` publishes every command to agents, so an eval command would appear in `ghx --help`.
- Not shipped in the npm package. It lives under `scripts/`, which is outside `files`.
- No telemetry leaves the machine.
- No new runtime dependencies. Bootstrap and rank tests are a few dozen lines.

## Layout

```
scripts/eval/
  cli.ts                 ghx-eval entry: snapshot | ingest | observe | oracle | ab | report
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
  ab/
    arms.ts tasks/<t>.ts run.ts      (tier 3)
test/unit/eval-*.test.ts
test/fixtures/eval/      small, redacted JSONL fixtures with known answers
```

Run with `pnpm eval <subcommand>`. Reuse `scripts/acceptance/score.ts` for its background-wait and notification logic rather than writing a second parser; move shared pieces into `scripts/eval/model/` and have `score.ts` import them.

## Determinism contract

Every report carries enough to reproduce it. These are requirements, and each has a test.

1. **Frozen input.** A run reads a manifest, not a directory. The manifest lists path, size, mtime and sha256 for every file, plus a hash of the list. Files modified in the 6 hours before the snapshot are excluded and the cutoff is recorded.
2. **Own store.** `ingest` copies new and grown transcripts into `~/.ghx-eval/corpus/` incrementally, keyed by path and byte offset, so retention in `~/.claude` can't change a past report.
3. **Stable order.** Files sort by path, records by file order. Nothing iterates a `Map` built from filesystem order or depends on timestamps for structure.
4. **Versioned definitions.** `METRIC_VERSION`, every constant (c = 2.2, overhead 70, episode slack 3, gap 10 min, reference context 50k, rewrite threshold 0.5, carry horizon 50) and the price table are emitted in `report.json`. Changing any of them bumps the version.
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
2. **PR cycle.** Every unit on one PR between two head SHAs. Head SHAs come from `headRefOid` in gh output and `headSha` in ghx output; fall back to `git push` boundaries only when neither appears, and flag it.
3. **PR lifecycle.** One session and its subagents, one PR, create to merge.
4. **Session.** GitHub's share of a session's calls and cost. Too few pure-ghx sessions exist for an arm comparison here; report shares by era instead.

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

## Tier 3: controlled A/B

Use the sandbox repo specified in 03 §4.4.1 (`ci/mode.json` switches between fail, flaky, slow, stuck and bot-comment).

- **Arms:** ghx (what `ghx install --scope project` writes: CLAUDE.md block and hook), gh with no instructions, and gh with an expert gh block of similar length. Prompts identical apart from that block; same model, `--effort`, `--tools` and permission mode.
- **Isolation:** a temporary `CLAUDE_CONFIG_DIR` per arm, a PATH built from an allowlist with `command -v ghx` asserted to fail in gh arms, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` removed, and a fresh clone and `GHX_ARTIFACT_DIR` per run. Don't use `--bare`.
- **Order:** interleave arms in a seeded random order.
- **Success:** a `--json-schema` answer checked against ground truth, plus the GitHub state read back afterwards.
- **Scoring:** feed each run's on-disk session JSONL through the tier 1 pipeline, so all three tiers share one metric core. Use the result message's `num_turns` and `total_cost_usd` as cross-checks.
- **Budget:** `--max-budget-usd` and `--max-turns` on every run. Pilot: 3 fixtures × 3 arms × 4 reps = 36 runs, about $25–50. Call-count effects of the size seen (6 → 1) settle in 3–5 reps; success-rate differences need about 30 per arm.

## ghx instrumentation (optional, opt-in)

Tier 1 infers ghx's behaviour from Bash commands. Two opt-in local logs would make it exact:

- **Hook log** (`GHX_HOOK_LOG=<path>`): the PreToolUse hook appends one NDJSON line per Bash or Monitor command it sees, raw gh included, with `session_id`, `cwd`, the command, and the hook's decision. It is the only place that sees both arms with a session id.
- **Invocation log** (`GHX_LOG=<path>`): a ProcessRunner decorator, modelled on `src/proc/recording.ts`, records each ghx invocation's command, exit code, duration, output bytes and the gh calls behind it.

Both are off by default, write only locally, and are joined to transcripts on `session_id`, falling back to cwd plus timestamp.

## Milestones

Each milestone lands as its own commits with tests and passes `pnpm check`.

| M | Deliverable | Done when |
|---|---|---|
| M0 | `snapshot` and `ingest`: manifest, incremental copy to `~/.ghx-eval/corpus/`. Import the 2026-10-29 archive. | Two snapshots of an unchanged corpus produce the same manifest hash |
| M1 | `model/` and `classify/`: the five tables, all ten parsing rules | Each rule has a fixture test; token totals for one unresumed main session match its `cost-state` within 2% |
| M2 | `units/` and `metrics/`: episodes, waits, PR cycles and lifecycles, the catalog | Episode counts within 3% of the Python prototype on the 2026-10-29 snapshot |
| M3 | `report/` and `observe`: report.json and report.md | Golden test passes; findings §4 tables reproduce from the snapshot |
| M4 | Tier 2 oracle with 8 questions | Every question answered correctly by the ghx and expert-gh scripts |
| M5 | Hook and invocation logs in ghx | Off by default; a session with both on joins every ghx call to its tool_use |
| M6 | Tier 3 pilot | 36 runs, per-arm report, cost within budget |

M0 is urgent: the gh-era baseline loses a day every day until about 2026-11-22.

## Open checks before M6

1. Does a `setup-token` token (`CLAUDE_CODE_OAUTH_TOKEN`) authenticate under a temporary `CLAUDE_CONFIG_DIR`? `claude auth status` answers it at no cost.
2. Does `--setting-sources` stop `~/.claude/CLAUDE.md` loading while a `--settings` hook still runs? Check with a canary string.
3. How does a background `ghx ci wait` behave under `-p` on the pinned Claude Code version (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`)?
4. Does the Bash environment expose a session id the hook log can record?

## Follow-ups for ghx itself

The preliminary findings (§4 and §5) already point at product work. These are separate from this plan and should be confirmed by M3 before acting on them:

- `pr create` and `pr edit` fail validation on about half of first attempts, and `ghx schema pr create` costs about 12.5k characters to read. A shorter error hint or a smaller schema view would cut the subagent pr-write regression.
- 23 unknown-command errors are agents guessing gh's shape (`ghx pr view`, `ghx run view --log`, `ghx ci logs`, `ghx pr ready`). Aliases or hints that name the ghx equivalent would turn these into one call.
- The `ci wait` notification carries no result, so the agent reads the output file afterwards (166 times). A summary line inside the notification would save that call.
- In subagents, background waits that idle past 5 minutes pay a cache rewrite on wake. Guidance for subagents may need to differ from main threads.
- Status reads (`pr status`) return about 3× the characters of the gh equivalent; check whether agents should reach for `--brief` by default.
