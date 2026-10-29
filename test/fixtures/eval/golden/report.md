# ghx-eval: GitHub work with ghx and with raw gh

> Pre/post compares the adoption bundle, not ghx alone: ghx, its PreToolUse hook, the CLAUDE.md block and the no-sleep memory arrived together. The data are observational: sessions differ in their work, model mix and share of subagents, so a difference here is an association, not an effect of ghx.

Read 13 session files (528,326 bytes): 9 sessions, 2 subagents, 196 API calls, 133 tool calls (41 gh, 32 ghx), $1.64 estimated cost.

METRIC_VERSION 1.1.0, prices 2026-10-29.1, ghx-eval/report@2. Medians with 95% CIs from a cluster bootstrap: resample sessions with replacement, percentile interval (seed 42, B = 1000); quantiles by linear interpolation between order statistics (Hyndman-Fan type 7); tests: Mann-Whitney U, two-sided, normal approximation with tie and continuity correction. Cells with n < 5 are marked °, have no CI and stay out of the summary.

Excluded and deduplicated:

- `<synthetic>` records (API errors): 1
- Dev projects (bucket dogfood-dev, never compared): 1 sessions, 2 units in `-tmp-golden-gh-for-agents`
- Files not read (not a transcript, subagent meta or skill-fork file): 7
- Parse errors: 1 lines in 1 files, 0 unreadable .json files, 1 partial last lines (49 bytes)
- Invalid records: none; unknown record types: none
- Files outside any session: 0; unlinked agents: 0
- Deduplicated: 131 assistant records, 0 fork-copied API calls, 15 repeated notification sightings

## Buckets

Atomic units (episodes and waits) per bucket. gh-pre and ghx-post are an adopted repo before and after adoption; gh-post is raw gh there after adoption; dogfood-dev is ghx’s own development; never-adopted is every other repo.

| bucket | units | sessions | dominant sessions |
|---|---|---|---|
| gh-pre | 23 | 4 | **2 sessions hold 57%**: `c01d0002` (-tmp-golden-acme, 30%), `c01d0001` (-tmp-golden-acme, 26%) |
| ghx-post | 28 | 3 | **2 sessions hold 82%**: `c01d0012` (-tmp-golden-acme, 46%), `c01d0011` (-tmp-golden-acme, 36%) |
| gh-post | 1 | 1 | **1 session holds 100%**: `c01d0013` (-tmp-golden-acme, 100%) |
| dogfood-dev | 1 | 1 | **1 session holds 100%**: `c01d0031` (-tmp-golden-gh-for-agents, 100%) |
| never-adopted | 3 | 1 | **1 session holds 100%**: `c01d0021` (-tmp-golden-widgets, 100%) |

## Summary

Comparisons with n ≥ 5 on both sides only. Medians; p from Mann-Whitney U.

- **status**, main, `-tmp-golden-acme`, claude-opus-5-5, gh-pre → ghx-post (n 6 → 8): round trips 1 → 1 (p 1.000); tool calls 1 → 1 (p 1.000); cost norm $0.027 → $0.027 (p 0.846)
- **intent: status**, main, `-tmp-golden-acme`, claude-opus-5-5, gh-pre → ghx-post (n 6 → 8): round trips 1 → 1 (p 1.000); tool calls 1 → 1 (p 1.000); cost norm $0.027 → $0.027 (p 0.846)

## Turns

Three numbers, because they measure different costs: human turns (prompts a person typed), round trips (API calls that emitted one of the unit’s tool calls) and tool calls (GitHub plus glue). Wakeups (notifications that started or fed a call) sit beside them for waits. Medians [95% CI].

| unit | context | repo | model | bucket | n | human turns | round trips | tool calls | wakeups |
|---|---|---|---|---|---|---|---|---|---|
| wait: bg-gh-loop | main | -tmp-golden-acme | claude-fable-5-1 | gh-pre | 1° | _0_° | _2_° | _2_° | _1_° |
| wait: bg-gh-loop | main | -tmp-golden-acme | claude-opus-5-5 | gh-pre | 3° | _0_° | _2_° | _2_° | _1_° |
| wait: bg-ghx-ci-wait | main | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 3° | _0_° | _2_° | _2_° | _1_° |
| wait: bg-ghx-ci-wait | subagent | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 1° | _0_° | _2_° | _2_° | _1_° |
| pr lifecycle | main | -tmp-golden-acme | claude-fable-5-1 | gh-pre | 1° | _4_° | _9_° | _9_° | _1_° |
| pr lifecycle | main | -tmp-golden-acme | claude-opus-5-5 | gh-pre | 3° | _5_° | _10_° | _10_° | _1_° |
| pr lifecycle | main | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 8 | 0 [0–9] | 1 [1–12] | 1 [1–12] | 0 [0–1] |
| pr lifecycle | main | -tmp-golden-widgets | claude-opus-5-5 | never-adopted | 3° | _0_° | _1_° | _1_° | _0_° |
| pr lifecycle | subagent | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 1° | _0_° | _4_° | _4_° | _1_° |
| session | main | -tmp-golden-acme | claude-fable-5-1 | gh-pre | 1° | _5_° | _20_° | _14_° | _1_° |
| session | main | -tmp-golden-acme | claude-opus-5-5 | gh-pre | 3° | _6_° | _23_° | _16_° | _1_° |
| session | main | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 3° | _10_° | _31_° | _20_° | _1_° |
| session | main | -tmp-golden-gh-for-agents | claude-opus-5-5 | dogfood-dev | 1° | _1_° | _3_° | _2_° | _0_° |
| session | main | -tmp-golden-widgets | claude-opus-5-5 | never-adopted | 1° | _3_° | _6_° | _3_° | _0_° |

## By intent

Episodes and background waits by intent (derived waits excluded), gh-pre → ghx-post, one table per repo and model. Tool calls and result characters: median [95% CI] p90.

### `-tmp-golden-acme`, claude-opus-5-5

| intent | context | n gh / ghx | tool calls | p | result chars | with error | wall-clock s |
|---|---|---|---|---|---|---|---|
| create | main | 1° / 3° | _1 p90 1_° → _2 p90 3.6_° | – | _39 p90 39_° → _62 p90 204_° | _0%_° → _33%_° | _3 p90 3_° → _13 p90 29_° |
| diagnose | main | 3° / 3° | _3 p90 3_° → _1 p90 1_° | – | _1,162 p90 1,210_° → _164 p90 164_° | _0%_° → _0%_° | _23 p90 23_° → _3 p90 3_° |
| diagnose | subagent | 1° / 1° | _3 p90 3_° → _1 p90 1_° | – | _1,749 p90 1,749_° → _164 p90 164_° | _0%_° → _0%_° | _23 p90 23_° → _3 p90 3_° |
| merge | main | 3° / 3° | _2 p90 2_° → _1 p90 1_° | – | _293 p90 293_° → _77 p90 77_° | _0%_° → _0%_° | _13 p90 13_° → _3 p90 3_° |
| status | main | 6 / 8 | 1 [1–1] p90 1 → 1 [1–1] p90 1 | 1.000 | 142 [142–142] p90 252 → 262 [261–263] p90 263 | 0% → 0% | 3 [3–3] p90 3 → 3 [3–3] p90 3 |
| wait | main | 3° / 3° | _2 p90 2_° → _2 p90 2_° | – | _207 p90 207_° → _285 p90 285_° | _0%_° → _0%_° | _859 p90 859_° → _1,099 p90 1,099_° |

## By unit, split by context

gh-pre → ghx-post. Round trips here are GitHub round trips (API calls emitting a gh/ghx call); cost_norm is the headline dollar figure. Medians [95% CI]; the rest are means per unit.

### `-tmp-golden-acme`, claude-opus-5-5

| unit | context | n gh / ghx | GitHub round trips | cost_norm | p | pipes | errors | refusals | cache rewrites | result tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| create | main | 1° / 3° | _1_° → _1_° | _$0.026_° → _$0.041_° | – | _0.00_° → _0.00_° | _0.00_° → _0.33_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _87.73_° → _98.18_° |
| diagnose | main | 3° / 3° | _3_° → _1_° | _$0.065_° → _$0.027_° | – | _2.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _738_° → _145_° |
| diagnose | subagent | 1° / 1° | _3_° → _1_° | _$0.080_° → _$0.032_° | – | _2.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _1,005_° → _145_° |
| merge | main | 3° / 3° | _2_° → _1_° | _$0.042_° → _$0.026_° | – | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _273_° → _105_° |
| status | main | 6 / 8 | 1 [1–1] → 1 [1–1] | $0.027 [$0.027–$0.027] → $0.027 [$0.027–$0.028] | 0.846 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 134 [134–134] → 189 [189–190] |
| pr cycle | main | 3° / 8 | _3_° → 1 [1–2] | _$0.111_° → $0.027 [$0.027–$0.083] | – | _1.00_° → 0.00 | _0.00_° → 0.00 | _0.00_° → 0.00 | _0.00_° → 0.00 | _503_° → 190 [190–458] |
| pr cycle | subagent | 1° / 1° | _1_° → _1_° | _$0.028_° → _$0.298_° | – | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _0.00_° | _0.00_° → _1.00_° | _185_° → _270_° |
| pr lifecycle | main | 3° / 8 | _9_° → 1 [1–10] | _$0.247_° → $0.027 [$0.027–$0.318] | – | _3.67_° → 0.00 | _0.00_° → 0.13 | _0.00_° → 0.00 | _0.00_° → 0.00 | _1,575_° → 190 [190–1,247] |

## Waiting for CI, by mechanism

Wait units per repo, model and bucket. cost_norm per wait: median [95% CI]; cache rewrites: mean per wait.

| mechanism | context | repo | model | bucket | n | cost_norm | cache rewrites | round trips | wakeups | span calls |
|---|---|---|---|---|---|---|---|---|---|---|
| bg-gh-loop | main | -tmp-golden-acme | claude-fable-5-1 | gh-pre | 1° | _$0.081_° | _0.00_° | _2_° | _1_° | _4_° |
| bg-gh-loop | main | -tmp-golden-acme | claude-opus-5-5 | gh-pre | 3° | _$0.053_° | _0.00_° | _2_° | _1_° | _4_° |
| bg-ghx-ci-wait | main | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 3° | _$0.053_° | _0.00_° | _2_° | _1_° | _4_° |
| bg-ghx-ci-wait | subagent | -tmp-golden-acme | claude-opus-5-5 | ghx-post | 1° | _$0.298_° | _1.00_° | _2_° | _1_° | _4_° |

## Whole PR lifecycle

One session (with its subagents) and one PR, created and merged in that session; gh-pre vs ghx-post. A lifecycle is filed under main when any of its work ran in the main thread. Medians [95% CI].

### `-tmp-golden-acme`, claude-opus-5-5

main:

|  | raw gh (1°) | ghx (3°) | p |
|---|---|---|---|
| GitHub calls | _9_° | _7_° | – |
| Result chars | _1,924_° | _1,027_° | – |
| Wakeups | _1_° | _1_° | – |
| CI rounds | _1_° | _1_° | – |
| Elapsed (h) | _0.36_° | _0.41_° | – |
| Round trips | _10_° | _9_° | – |
| cost_norm | _$0.247_° | _$0.212_° | – |

## Definitions

Constants: `CHARS_PER_TOKEN` = 2.2, `RESULT_OVERHEAD` = 70, `RECOVERY_MIN_SHARE` = 0.5, `EPISODE_SLACK` = 0, `EPISODE_GAP_MS` = 600000, `REF_CTX` = 50000, `REWRITE_THRESHOLD` = 0.5, `REWRITE_MIN_CTX` = 5000, `CARRY_HORIZON` = 50, `PRICE_TABLE_VERSION` = "2026-10-29.1".

Prices 2026-10-29.1 (USD per MTok, input / output / cache read; cache writes 1.25× input for 5m, 2× for 1h): claude-fable-5 $10 / $50 / $1; claude-fable-5-1 $10 / $50 / $0.25; claude-haiku-4-5 $1 / $5 / $0.1; claude-opus-5 $5 / $25 / $0.5; claude-opus-5-5 $4 / $20 / $0.2; claude-sonnet-5 $2 / $10 / $0.2.

| metric | unit | robustness | applies to | description | formula |
|---|---|---|---|---|---|
| `human_turns` | turns | robust | episode, wait, pr_cycle, pr_lifecycle, session | Prompts a person typed (findings §1.4) inside the unit. 0 for episodes by construction (a prompt closes one). | count of main-thread turns with is_human whose start lies inside the unit (session: all of them) |
| `round_trips` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | API calls that emitted one of the unit's tool calls (GitHub calls and glue). Findings §4.2's 'Round trips' column is gh_round_trips, which counts only calls emitting a GitHub call. Since 1.1.0, a wait keeps the status reads and foreground waits on its target right after its wake, and the first other GitHub call after a wake opens an episode flagged after-wake and ends the one open before the wait. | unique message.id over the unit's tool calls (session: all API calls) |
| `tool_calls` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub calls plus glue calls inside the unit (session: every tool call). | count of tool_use ids in the unit |
| `gh_round_trips` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | API calls that emitted at least one GitHub tool call. | unique message.id over GitHub tool calls |
| `span_calls` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | API calls charged to the unit (see Span). For a session, the sum over its GitHub units. Since 1.1.0, a wait keeps the status reads and foreground waits on its target right after its wake, and the first other GitHub call after a wake opens an episode flagged after-wake and ends the one open before the wait. | len(span) |
| `glue_calls` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | Glue tool calls: work done on GitHub output that is not itself a gh/ghx call. The prototype counted API calls (span_calls − linked − 1); units here carry glue explicitly, so this counts glue tool calls. | tool_calls − gh_tool_calls |
| `gh_tool_calls` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub tool calls. Since 1.1.0, a wait keeps the status reads and foreground waits on its target right after its wake, and the first other GitHub call after a wake opens an episode flagged after-wake and ends the one open before the wait. | count of Bash/Monitor calls running gh or ghx |
| `gh_invocations` | invocations | robust | episode, wait, pr_cycle, pr_lifecycle, session | gh/ghx invocations in the command texts (a compound command can hold several). | sum of n_invocations over GitHub calls |
| `distinct_cmds` | commands | robust | episode, wait, pr_cycle, pr_lifecycle, session | Distinct normalised command signatures. | unique signatures; signature = "<cli> <subcommand>" per invocation joined by " ; " |
| `repeats` | commands | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub calls that repeat an earlier signature. | gh_tool_calls − distinct_cmds |
| `retries` | commands | proxy | episode, wait, pr_cycle, pr_lifecycle, session | A GitHub call with the same signature as the previous one, which failed. | consecutive equal signatures where the first has error_kind ≠ null |
| `out_tok` | tokens | robust | episode, wait, pr_cycle, pr_lifecycle, session | Output tokens over the span (thinking included). Subagent values are recovered (M1 out_src); the recovery has a +14% aggregate bias. | sum output_tokens over span |
| `write_tok` | tokens | proxy | episode, wait, pr_cycle, pr_lifecycle, session | Output tokens spent writing GitHub calls: each emitting call’s output split across its tool calls by input size. | sum over GitHub-emitting calls of output_tokens × (GitHub tool input chars / all tool input chars) |
| `res_chars` | chars | robust | episode, wait, pr_cycle, pr_lifecycle, session | Characters of GitHub results and follow-up reads the model saw (tool_result.content). | sum result_chars over GitHub calls and read glue |
| `res_tok_est` | tokens | robust | episode, wait, pr_cycle, pr_lifecycle, session | Context added by GitHub results and follow-up reads (R² 0.93–0.96 against measured Δcontext). | sum over GitHub calls and read glue of result_chars / 2.2 + 70 |
| `res_tok_measured` | tokens | proxy | episode, wait, pr_cycle, pr_lifecycle, session | Measured Δcontext for GitHub calls where it is clean; validation only (about half of calls qualify). Null when no call qualifies. | sum over GitHub calls whose emitting call has one tool_use and whose next call is the next index of ctx(next) − ctx(call) − output_tokens(call) |
| `follow_reads` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | Glue calls that read GitHub output (redirect targets, logPath files, background output files). | count of read glue |
| `cache_read` | tokens | robust | episode, wait, pr_cycle, pr_lifecycle, session | Cache-read tokens over the span. Dominated by session context; do not compare raw across arms. | sum cache_read over span |
| `cache_write` | tokens | robust | episode, wait, pr_cycle, pr_lifecycle, session | Cache-write tokens (5m + 1h) over the span. | sum cache_creation over span |
| `cache_rewrites` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | Span calls that rewrote most of their context (an idle gap past the cache lifetime: 5m subagent, 1h main). | count of span calls with context > 5000 and cache_creation / context > 0.5 |
| `cost` | usd | robust | episode, wait, pr_cycle, pr_lifecycle, session | Priced usage over the span, including 5m/1h cache writes and advisor iterations. Confounded by context size. Caveats (M1): subagent advisor cost is invisible in transcripts; opus is 6–20% under cost-state in subagent-heavy sessions (unrecorded side calls). Since 1.1.0, a wait keeps the status reads and foreground waits on its target right after its wake, and the first other GitHub call after a wake opens an episode flagged after-wake and ends the one open before the wait. | sum cost_usd over span |
| `cost_norm` | usd | robust | episode, wait, pr_cycle, pr_lifecycle, session | Headline dollar figure (findings §2): keeps the unit’s own context growth and cache rewrites but replaces the session’s base context with 50k. Same caveats as cost. Since 1.1.0, a wait keeps the status reads and foreground waits on its target right after its wake, and the first other GitHub call after a wake opens an episode flagged after-wake and ends the one open before the wait. | sum over span of [output + advisor cost + input cost × max(0, ctx − C0 + 50000) / ctx], C0 = context of the first span call, input cost = cost − output − advisor |
| `carry_cost_h50` | usd | proxy | episode, wait, pr_cycle, pr_lifecycle, session | Re-reading GitHub results on later calls, capped at 50 calls. Depends on unrelated later work; secondary. | sum over GitHub calls and read glue of (result tokens + allocated emitting output) × min(calls until compaction or end of file, 50) × cache-read price |
| `wall_s` | seconds | proxy | episode, wait, pr_cycle, pr_lifecycle, session | Elapsed time from the unit’s first call to its last event. Includes CI’s own duration: report, never optimise. | end_ts − start_ts |
| `blocked_s` | seconds | robust | episode, wait, pr_cycle, pr_lifecycle, session | Time the agent waited on foreground GitHub calls. | sum over foreground GitHub calls of result_ts − call_ts |
| `errors` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub calls that failed: a non-zero exit, a ghx error body (even behind a pipe), a hook block or a denial. ghx exits 10, 11 and 15 are outcomes, not errors. | count of GitHub calls with error_kind ≠ null |
| `refusals` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub calls refused by ghx policy, a hook, the permission system or the harness. | count of GitHub calls with refusal ≠ null |
| `pipes` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub commands piped into another command. | count of GitHub calls with glue.pipe |
| `jq` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub commands using --jq, -q or \| jq. | count of GitHub calls with glue.jq |
| `sleep_loops` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub commands with a sleep or a while/until loop (polling). | count of GitHub calls with glue.sleep or glue.loop |
| `watch` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub commands using --watch or run watch. | count of GitHub calls with glue.watch |
| `bg` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | GitHub Bash calls that ran in the background. | count of GitHub Bash calls with run_in_background or a background task id |
| `monitor` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | Monitor tool calls whose script runs gh or ghx. | count of GitHub Monitor calls |
| `notifications` | notifications | robust | episode, wait, pr_cycle, pr_lifecycle, session | Task notifications for the unit’s background GitHub calls and Monitors (each counted once: rule 6). | sum notif_count over background GitHub calls |
| `wakeups` | calls | robust | episode, wait, pr_cycle, pr_lifecycle, session | Distinct API calls that a notification of the unit started or fed (a notification arriving mid-turn and one starting a turn both make the next call read it). Reported per wait and per lifecycle. | unique (file, call index) of the call after each notification of the unit |
| `rounds` | rounds | robust | pr_cycle, pr_lifecycle | CI rounds: distinct head SHAs seen on the PR (git push boundaries when no SHA is visible: flag sha-fallback). | pr_cycle: 1; pr_lifecycle: number of its cycles |
| `units` | units | robust | pr_cycle, pr_lifecycle, session | Episodes and waits the unit is built from. | len(children) |
| `api_calls` | calls | robust | session | API calls in the session (main + subagents). | unique message.id |
| `gh_share_calls` | ratio | robust | session | GitHub work’s share of the session’s API calls. | span_calls (union over episodes and waits) / api_calls |
| `gh_share_cost` | ratio | robust | session | GitHub work’s share of the session’s cost. | cost (union of episode and wait spans) / session cost |
