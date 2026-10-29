# 07: ghx-eval, a measure of ghx against raw gh in the sessions on disk

ghx-eval is a dev-only tool that reads the Claude Code sessions on this computer and reports what ghx changed about agents' GitHub work: turns, round trips, tool calls, tokens, cost, errors and glue. It builds on [ghx-impact-findings.md](../research/ghx-impact-findings.md), which holds the evidence for the rules below.

An earlier version also had a fake-gh replay oracle and a snapshot store with manifests. Both were removed on 2026-10-29 at the user's direction: the tool analyses the sessions that exist, and nothing else.

## What it does

One command:

```sh
pnpm eval [--summary] [--projects DIR] [--out DIR] [--json] [--era FILE]
```

- Start with `pnpm eval --summary`: one screen, in plain words, on whether ghx helps or hurts and where (median cost per task before and after ghx, the biggest problems, the caveats), rendered from the same report.json as the full report. `--summary --json` prints its data.

- It walks the projects directory (default `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`) in UTF-8 path order and reads every `*.jsonl` transcript, `*.meta.json` subagent meta and `*.forked-skill*.json` marker in place. Nothing is copied or cached.
- It prints report.md to stdout. `--json` prints report.json instead; `--out DIR` writes both files there.
- `--era FILE` overrides the adoption times and dev-project markers (`{"adoptions": {"<project slug>": "<ISO time>"}, "devProjectMarkers": [...]}`). The default is `DEFAULT_ERA_CONFIG` in `scripts/eval/model/session.ts`; add a repo there when it adopts ghx.

A full run over this machine's sessions takes about 13 s and 1.7 GB of memory. Run one at a time.

Claude Code deletes sessions after 30 days, so the report covers whatever is on disk at the time. Sessions still being written are read up to their last newline.

## Non-goals

- Not a `ghx` subcommand. The command registry auto-discovers `src/commands/**` and `docs:gen` publishes every command to agents.
- Not shipped in the npm package. It lives under `scripts/`, which is outside `files`.
- No telemetry leaves the machine, and no new runtime dependencies.

## Layout

```
scripts/eval/
  cli.ts          the command: flags, then pipeline.evaluate, then print or write
  pipeline.ts     projects directory → tables → units → report.json
  model/          read.ts (walk, JSONL to the last newline), records, dedupe, sessions, usage, pricing,
                  notifications (shared with scripts/acceptance/score.ts)
  classify/       gh / ghx / other, subcommand and glue; intent; errors and refusals
  units/          episodes, waits, PR cycles, PR lifecycles, sessions
  metrics/        catalog.ts (METRIC_VERSION, constants, one function per metric), stats.ts
  report/         json.ts (report.json), markdown.ts (report.md, from report.json only)
test/unit/eval-*.test.ts
test/fixtures/eval/   synthetic transcripts; golden/projects is a small projects directory with known answers
```

## Determinism

The same files on disk give the same bytes. Files sort by path and records by file order; nothing depends on directory order or timestamps for structure. The report holds no wall clock and no machine paths. Bootstrap uses a fixed seed (42) and B = 1000, resampling sessions. `METRIC_VERSION`, every constant (c = 2.2, overhead 70, episode slack 0, gap 10 min, reference context 50k, rewrite threshold 0.5, rewrite minimum context 5,000, carry horizon 50) and the price table are in report.json; changing one bumps the version.

The header of report.md says what was read (files, bytes, sessions, calls) and what was left out or merged: `<synthetic>` records, dev projects, files that are not session files, parse errors, partial last lines, invalid or unknown records, files outside any session, and deduplicated records.

The golden test runs the command on `test/fixtures/eval/golden/projects` and compares both reports byte for byte. `UPDATE_GOLDEN=1` regenerates them.

## Data model

Five tables, built one session at a time and held in memory:

| Table | Key | Main columns |
|---|---|---|
| sessions | session_id | project, cwd, version, entrypoint, first/last ts, title, n_compactions, pr_links, era (gh-pre, ghx-post, dogfood-dev, never-adopted) |
| agents | agent_id | session_id, parent_agent_id, spawn_tool_use_id, agent_type, request_shape, spawn_depth, model, is_fork |
| turns | turn_id | session_id, agent_id, starter_kind, is_human, start/end ts, interrupted |
| api_calls | message_id | session_id, agent_id, turn_id, model, ts, input, cache_read, cache_creation (1h/5m), context_tokens, output_tokens, out_src, advisor tokens, stop_reason, after_compaction |
| tool_calls | tool_use_id | message_id, agent_id, turn_id, name, command, cli, subcommand, run_in_background, call/result ts, is_error, exit_code, error_kind, result_bytes, persisted, background_task_id, notif ts/status/exit, output_file_read_bytes |

Column sources are in findings §1.

## Parsing rules that silently corrupt results if missed

Each has a unit test with a fixture built from a real record shape.

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

- **Human turns**: prompts a person typed (findings §1.4). How often the user had to step in.
- **Round trips**: API calls (unique `message.id`) inside a unit. The agent loop; it dominates cost.
- **Tool calls**: GitHub calls plus glue calls inside a unit. How many steps a question took.

Wakeups (notifications that start a turn) sit beside round trips for wait units.

## Units

1. **Intent episode with continuations.** The atomic unit (findings §3). Background-wait episodes, notification-triggered calls and output-file reads attach to the episode that started them.
2. **PR cycle.** The waits and status reads on one PR between two head SHAs. Head SHAs come from `headRefOid` in gh output and `headSha` in ghx output; fall back to `git push` boundaries only when neither appears, and flag it.
3. **PR lifecycle.** One session and its subagents, one PR, create to merge. A lifecycle takes every unit on the PR.
4. **Session.** GitHub's share of a session's calls and cost.

**The post-wake rule (METRIC_VERSION 1.1.0).** After a background wait's notification wakes the agent, the wait keeps its glue (output-file reads, TaskOutput, TaskStop) and status reads or foreground waits on its own target. Any other GitHub call opens a new episode flagged `after-wake`, linked to the wait through `parent_unit_id`.

## Metric catalog

`metrics/catalog.ts` holds the 32 metrics of the prototype catalog plus the three turns numbers, each with an id, a unit, a formula and a robustness flag.

- **Robust:** round trips, tool calls, GitHub invocations, glue calls, distinct commands, repeats, result tokens (`chars / 2.2 + 70`), cache rewrites, cost, `cost_norm`, errors, refusals, pipes, jq, sleep loops, `--watch`, background waits, Monitor scripts, notifications, human turns.
- **Proxy:** write tokens (allocated across parallel tool calls), recovered subagent output tokens, carry-forward cost (capped at 50 calls), retries, intent, wall-clock (it includes CI's own duration; report it, never optimise it).

`cost_norm` is the headline dollar figure (findings §2).

## Comparison rules

These are hard constraints in `report/`, not options.

- Never pool main threads with subagents. Their cache lifetimes differ (1h vs 5m) and flip the CI-wait result.
- Fix repo and model inside a comparison. Different models go in separate cells.
- Separate buckets: `gh-pre` and `ghx-post` (an adopted repo before and after adoption), `gh-post` (raw gh there after adoption), `dogfood-dev` (ghx's own development, never compared), `never-adopted`. Comparisons are gh-pre → ghx-post and gh-post → ghx-post.
- Cells with n < 5 are shown greyed with no CI and kept out of any summary line.
- Show medians and p90 with a 95% bootstrap CI and n in every cell. Means only as a secondary column.
- The report header states that pre/post measures the adoption bundle (ghx, hook, CLAUDE.md block, memory), not ghx alone, and names the dominant sessions when two or fewer hold more than half of a bucket.

## ghx instrumentation (optional, opt-in)

The tool infers ghx's behaviour from Bash commands. Two opt-in local logs make it exact:

- **Hook log** (`GHX_HOOK_LOG=<path>`): the PreToolUse hook appends one NDJSON line per Bash or Monitor command it sees, raw gh included, with `session_id`, `tool_use_id`, `cwd`, the command and the hook's decision.
- **Invocation log** (`GHX_LOG=<path>`): each ghx invocation's command, exit code, duration, output bytes and the gh calls behind it, with the session id from `CLAUDE_CODE_SESSION_ID`.

Both are off by default and write only locally; `src/hook/join.ts` joins them. See [hooks.md](../agents/hooks.md).

## Follow-ups for ghx itself

From the 2026-10-29 report (powerhouse, claude-opus-5-5, gh-pre → ghx-post, medians). Re-check them against a fresh `pnpm eval`.

- **`pr create` and `pr edit` validation.** 50% of ghx create episodes and 47% of edit episodes hit an error, against 2–6% with gh. `VALIDATION` is the top ghx error code. A shorter error hint or a smaller `ghx schema pr create` view is the fix to try first.
- **Unknown commands.** 23 `USAGE_UNKNOWN_COMMAND` errors, agents guessing gh's shape. Aliases or hints that name the ghx equivalent would turn each into one call.
- **The `ci wait` notification carries no result.** 155 of 182 background `ci wait` calls (85%) are followed by a read of the output file. A summary line in the notification would save that call.
- **Subagent waits.** A background `ghx ci wait` costs $0.296 per wait in a subagent against $0.075 in a main thread. A gh background loop costs the same in a subagent, so the cost comes from the 5-minute cache, not from ghx.
- **Result size.** Subagent status reads return 2,558 characters against 620. Check whether `--brief` should be the default for status reads.
- **Diagnosis in subagents is the clearest win.** Tool calls 2 → 1, result characters 3,954 → 988, cost_norm $0.113 → $0.060 (p < 0.001).
