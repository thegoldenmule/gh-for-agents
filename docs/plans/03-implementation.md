# 03: Implementation and testing plan for `ghx`

Status: draft. Inputs:
- `00-brief.md`. Its "Decisions" sections and its "CI waiting protocol" section override 01 and 02.
- `01-scaffolding.md`, cited as 01 §N.
- `02-api.md` (commit `eecce12`: the background, duration-free `ci wait` protocol and restored read passthrough), cited as 02 §N.
- `docs/research/gh-usage-findings.md`, cited as §N.

This plan says **in what order** the design gets built, **what each commit proves**, and **which tests land with it**. It adds no new commands. Where the docs still disagree, §1 picks one answer, and the rest of this plan assumes it.

All work lands on `main` as small commits, each with its own tests, and each leaving `pnpm check` green. Nothing is pushed or tagged without the user asking.

---

## 0. Summary

- **Order.**
  1. Spikes (done, §3), then the 01 bootstrap.
  2. The CI core, then `ci why`, `ci wait`, and `ci rerun`/`retrigger`.
  3. `pr status`, with the policy engine.
  4. Passthrough, then `pr merge`, `pr create`, `pr edit` and the feedback writes.
  5. Agent steering and acceptance.

  CI babysitting is 55% of gh traffic (§0, §2.1). The first usable cut, after M4, answers "why is CI red" and "tell me when it's done" with no write command present.
- **The CI wait protocol** (brief; 02 §11.0). The agent runs `ghx ci wait <pr>` with `run_in_background: true` and is woken when it exits. stdout is one `WaitSummary`, and the exit code is the outcome. There are no caller durations. The wait ends only on CI-derived states, including `stalled` (14), plus `pending` (15) for unattended sessions. It is resumable. The tests prove: one tool call and one wake per wait; stall rules on a fake clock; resume without repeated work; and the hook's `run_in_background` rewrite, which the spike in §3.6 confirmed works.
- **Test layers.**
  - unit tests on pure modules;
  - a fake-gh double for in-process command tests;
  - CLI contract tests that spawn the real bin against a fake `gh` on PATH;
  - named regression tests, one per finding;
  - an opt-in live suite against a sandbox repo.
- **Fixtures** are recorded from a sandbox repo and from public repos through a recording mode in the process runner, then redacted and committed. The transcript corpus only tells us *which* shapes to capture. Almost every result in it was filtered through `--jq`, `head` or `tail`, so the raw bytes aren't there (§0: 66% piped, 968 `--jq`).
- **Exit codes and error names** come from revised 02 §6. Tests read them from one table file, `test/contract/exit-table.ts`, which is a copy of 02 §6.1. A renumbering means editing one file.

---

## 1. Reconciliations this plan assumes

**Resolved by 02 at `eecce12` (no action needed):**
- Config at `.github/ghx.json`.
- `--input` is explicit (`USAGE_INPUT_MISSING`).
- 16 KB `maxBytes`.
- 01's error names (`VALIDATION`, `USAGE_*`, `ENV_*`, `GH_FAILED`, `TIMEOUT`).
- Exit table 0–15: STATE is 9; the `ci wait` outcomes are 10–15, including `stalled` 14 and `pending` 15. The multi-target precedence is 10 > 14 > 13 > 12 > 15 > 11 > 0.
- `ci wait` is strictly a read, flaky reruns live in `ci rerun --flaky`, and passthrough is allowlisted reads in an envelope (02 §10: `PASSTHROUGH_WRITE_REFUSED` 6, `GH_FAILED` 7, `DIFF_TOO_LARGE`).

**Still reconciled here:**

| # | Topic | Conflict | This plan |
|---|---|---|---|
| 1 | `ci wait` default mode | 02 §11.2's table says `settled (default)`; 02 §11.1 and the brief say `first-failure` | **`first-failure`** (brief) |
| 2 | Spilling the `ci wait` summary | 02 §15 ask 2 says an oversized summary spills; 02 §11.1 says it is never spilled | **Never spilled** (§11.1). Per-target detail is compacted, with the full JSON at `diagnosisPath`. A spill would turn the wake into a second tool call |
| 3 | `ci wait` stdout and the runner | 01 §3.6 has only NDJSON stream mode; 02 wants one document by default, with events in `eventsPath` | 01's stream runner gains an output mode. **`final`** (default for `ci wait`) appends every line to `eventsPath` and prints only the terminal object as one JSON document. **`ndjson`** (`--stream`) is 01's existing behaviour. Specs may declare `timeout: null`, meaning no deadline. On a signal, `final` mode prints the generator's `interrupted` summary as that one document |
| 4 | Expected checks that never register | 02 §11.3 still says a missing required or config check "stays in `expectedMissing` until the budget runs out", but there is no budget now. The stall rules only cover queued and running checks | Termination gap. A required check whose workflow never triggers (path filters, a renamed job) would keep an attended wait open forever. This plan proposes: once everything else has settled, a required or config check still missing after `ci.stall.queuedMinutes` gives `stalled`, with a `stalled[]` entry `{state:"missing"}`. That needs `"missing"` added to the `stalled[].state` enum (Q1). Tested in M4.5 |
| 5 | Stale fields in the worked example | 02 §14.4's `start` event still carries `advice` | Golden fixtures follow the §11.9 schema (no `advice`, no `budgetSec`) |
| 6 | Repo resolution from cwd | 01: local git remote parse; 02 §1.2: `gh repo view` | **01.** A local parse mirroring gh's `gh-resolved` rules, with no network |
| 7 | Config `components` | 01: record keyed by name; 02 §15: array of `{name, paths, minRisk}` | **01's record**, extended with `minRisk`. 02 §15 keys are added by the milestone that first reads them |
| 8 | Block escaping | Both 01 §6 and 02 §9.1 render the escape as `<` → `<` (garbled) | Intended rule: `<`→`\u003c`, `>`→`\u003e`, `&`→`\u0026`, so `a --> b` is stored as `"a --\u003e b"`. 01's regex is kept. The codec test pins the exact bytes |
| 9 | Internal gh failure codes | 01 §4.3 classifier codes vs 02's public catalogue | Internal codes stay internal and map to public ones in `src/core/errors.ts`: `GH_NOT_INSTALLED` → `ENV_GH_MISSING` (4); `GH_AUTH` → `ENV_GH_AUTH` (4); `GH_TRANSIENT`/`GH_TIMEOUT` after retries → `GH_FAILED` (7); `GH_RATE_LIMITED` → `GH_RATE_LIMITED` (7); `GH_NOT_FOUND` → `PR_NOT_FOUND`/`RUN_NOT_FOUND`/`REPO_NOT_FOUND`/`REF_NOT_FOUND` (5) by call site; `GH_TOO_LARGE` → `DIFF_TOO_LARGE` (7); `GH_IN_PROGRESS` is never surfaced, because ghx doesn't call `run view --log` |
| 10 | Log fetch failures | 02 has only `LOGS_UNAVAILABLE` | Two warnings, from the spike results (§3.3): `LOGS_NOT_READY` (blob 404: the job is running or was skipped) and `LOGS_UNAVAILABLE` (410: past retention). Neither is an error |
| 11 | Read-back mismatch | 02 §2.6 step 8 asserts an exact read-back but names no code | **`READBACK_MISMATCH` (7)**, with `details.{field, sent, stored}`. A write never reports success over a mismatch (Q5) |
| 12 | Description `#` rule | 02 §2.1 bans headings | A heading is matched as `^#{1,6}\s`, so a line like `#3184 merged first, so …` is allowed. A boundary test pins it |
| 13 | Randomness | ids and ±10% jitter need it | `src/core/random.ts` (a `Random` interface, seeded in tests). `architecture.test.ts` bans `Math.random` and `crypto.randomUUID` outside it |
| 14 | Contract test directory | 01 calls these `test/e2e/*.e2e.test.ts` | Renamed to `test/contract/*.contract.test.ts`. "Live" means the sandbox suite (`test/live/`) |

---

## 2. Milestones

### 2.1 Why this order

1. **CI first.** `run view`, `pr checks`, `run list` and job-log calls make up 55% of all invocations (§0), and a diagnosis takes a median of 6 calls (§5.1). `ci why` and `ci wait` are reads, so they need none of the write machinery (validators, renderer, policy overrides). That makes them the cheapest high-value cut.
2. **`ci why` before `ci wait`.** `ci wait` folds the `ci why` engine into its failure events (02 §11.4). With the engine built first, `ci wait` is mostly polling, a state machine and stall detection.
3. **`ci rerun` right after `ci wait`.** `ci wait` lists `rerunCandidates` and suggests `ghx ci rerun <ref> --flaky` (02 §11.8). Shipping it with a `next[]` that names a missing command would teach agents to fall back to `gh run rerun`. `ci rerun` is also the smallest write, so it shakes out dry-run and write-mode gh before the risky writes.
4. **The policy engine before `pr status`.** `pr status.merge.ready` must equal "would `pr merge` proceed now" (02 §4.1), and `ci wait --until mergeable` uses the same CI gate. Building `src/policy/merge.ts` as a pure module first means one engine, tested once with a table, serves all three. Two implementations would drift, which is the failure this design exists to prevent.
5. **Passthrough before the writes.** The refusals (`pr view` → `pr status`, `pr checks` → `ci wait`, `run view --log` → `ci why`) retrain habits worth 534 + 522 + 78 calls (§2.1). A refusal can only point at a command that already exists, so passthrough lands after M6.
6. **`pr merge` before `pr create`.** Merge carries the most harm per call: unwanted squashes, other people's PRs, a hidden conflict, unpinned heads (§4.3, §7). Its engine already exists by M6, so it's cheap. `pr create` is about content quality and needs the biggest validator.
7. **Steering last.** The `permissions.deny` rules and the PreToolUse hook (brief decision) only make sense once every wrapped replacement exists.

**Usable cuts:**
- after M3, agents can diagnose CI;
- after M4, they can wait without sleeps;
- after M6, they get one-call PR state;
- after M8, merges are guarded;
- after M11, all of v1 exists.

### 2.2 Conventions for the commit lists

Each commit lists **Files**, **Proves** and **Tests**. Test paths:
- `test/unit/**`: mirrors `src/`.
- `test/commands/**`: in-process command tests using `runInProcess` and `FakeGh` (§4.2).
- `test/contract/**`: spawn `bin/ghx.js` with the fake `gh` binary on PATH (§4.3).
- `test/regression/**`: the named must-have tests (§5.2).
- `test/live/**`: the opt-in sandbox suite (§4.4).

Fixtures live under `test/fixtures/`. The full inventory is in §6.2.

---

### M0. Spikes and sandbox (before code)

The three unverified behaviours from 02 §15 (ask 5) were resolved on 2026-10-22 with read-only calls (§3). M0 keeps those probes re-runnable and sets up the repo that fixtures and live tests come from.

**M0.1 `chore(scripts): read-only gh spike probes`**
- Files: `scripts/spike-gh.ts`. It runs every §3 probe against public repos and prints one JSON object with each probe's status line, exit code, stderr and headers of interest.
- Proves: the §3 assumptions can be re-checked in one command after any gh upgrade. The live workflow (§7.2) runs it too.
- Tests: none. It's a probe; its outputs become fixtures in M1.6 and M1.7.

**M0.2 `test(sandbox): sandbox repo template and init script`**
- Files: `test/sandbox-template/**` (the full contents of the sandbox repo, §4.4.1) and `scripts/sandbox/init.ts`. The script pushes the template to `$GHX_SANDBOX_REPO`. The user runs it once, because it mutates a repo they create.
- Proves: the sandbox is version-controlled and reproducible.
- Tests: `test/unit/sandbox-template.test.ts`. It line-checks every workflow file (`on:`, `jobs:`, and that the controlling `ci/mode.json` exists) and validates the template's `.github/ghx.json` with `ConfigSchema`.

**M0.3 `chore(scripts): Claude Code hook probe`**
- Files: `scripts/spike-hook.ts`. It reproduces §3.6 in a temp directory: a throwaway PreToolUse hook, a scratch `--settings` file, and `claude -p --output-format stream-json`. It never touches the user's settings.
- Proves: the `updatedInput` rewrite that the M12.2 hook depends on still works on the installed Claude Code version. Re-run it after each Claude Code upgrade; it prints the version it tested.
- Tests: none. Its output is recorded in `test/fixtures/hook/*.json` (§6.2).

---

### M1. Bootstrap (01 §9, amended)

01 §9 commits 1–14 land as written, with the amendments below. Commits 15 (agent docs) and 16 (hook) move to M12.

| 01 commit | Amendment |
|---|---|
| 1 tooling | Add the scripts `test:contract`, `test:regression`, `test:live`, `test:coverage`, `fixtures:record` and `fixtures:verify`. `pnpm test` runs `test/{unit,commands,contract,regression}/**` and `test/*.test.ts`, never `test/live` |
| 2 CI | Workflow contents as in §7.1 |
| 3 errors | `exit.ts` takes revised 02 §6.1. `errors.ts` holds 02 §6.2 plus §1's additions, and the internal-to-public mapping (§1 row 9). It also adds `test/contract/exit-table.ts`, the single copy of 02 §6.1 that tests import |
| 4 clock | Adds `src/core/random.ts` and the `Math.random` ban |
| 5 proc | Adds `src/proc/recording.ts` (recording mode, §6.1) |
| 6 gh exec | Classifier rows from §3, in this order: `HTTP 304` (only inside `api()`); blob 404 → `GH_LOGS_NOT_READY`; `HTTP 410` → `GH_LOGS_GONE` (non-transient, and **before** the `Server Error` → `GH_TRANSIENT` row); GraphQL `errors[].type == NOT_FOUND` → `GH_NOT_FOUND`. The read guard allows `api` GET with an `If-None-Match` header (02 §15 ask 4) |
| 7 api/graphql | The header parser accepts `HTTP/1.1` and `HTTP/2.0` status lines, CRLF or LF, and duplicate header names. A text body has its leading BOM stripped. With `If-None-Match`, exit 1 plus status 304 gives `notModified: true`. `graphql()` parses stdout **before** trusting the exit code |
| 9 cli | `test/e2e` becomes `test/contract` |
| 10 stream | Output modes `final` and `ndjson` (§1 row 3). The terminal line is bounded by `maxBytes`. Signal exit codes 130 and 143. A stream spec may declare **no deadline** (`timeout: null`), which `ci wait` needs. Without a deadline, the runner still honours signals and the grace window. Tests: in `final` mode stdout is exactly one JSON document, and the `eventsPath` file holds every line with gapless `seq` |
| 12 codec | Escaping per §1 row 8 |

Two commits are added after 01's commit 14.

**M1.15 `test(helpers): fake gh double with scenarios, call assertions and timelines`**
- Files:
  - `test/helpers/fake-gh.ts`;
  - `test/helpers/fixture-match.ts` (argv canonicalisation and matching, shared with the bin);
  - `test/helpers/scenario.ts` (loads `test/fixtures/gh/<scenario>/`);
  - a rewrite of `test/fixtures/bin/gh` on top of `fixture-match.ts`.
- Proves: every later command test can replay recorded gh output, assert the exact call sequence, and script state over fake time (§4.2, §4.3).
- Tests:
  - `test/unit/helpers/fake-gh.test.ts`: matching; successive replies; an unmatched call fails and names the nearest fixture; `expectNoMutations` uses `guard.isMutating`; timeline replies are selected by `FakeClock.monotonic()`.
  - `test/contract/fake-gh-bin.contract.test.ts`: the bin replays a scenario, keeps a sequence counter across processes, and logs argv and env; a `hang` reply blocks until SIGTERM.

**M1.16 `chore(fixtures): recording, redaction and drift-check scripts`**
- Files: `scripts/fixtures/record.ts`, `scripts/fixtures/scenarios/*.ts` (one per scenario directory, §6.2), `scripts/fixtures/redact.ts`, `scripts/fixtures/verify.ts`.
- Proves: every committed fixture can be re-captured with one command, and a shape drift in gh or GitHub is caught (§6.1).
- Tests:
  - `test/unit/fixtures/redact.test.ts`: tokens, emails, request ids, SAS query strings, the blob `RequestId`, `Date` headers and logins are rewritten; timestamps and SHAs are kept.
  - `test/fixtures.test.ts`: every fixture parses, carries `meta.source`, contains no `gh[opsu]_` token or email address, and is referenced by at least one test.

---

### M2. CI core (shared by `ci why`, `ci wait`, `pr status`)

**M2.1 `feat(schemas): shared schemas and CiSummary`**
- Files:
  - `src/schemas/common.ts`: `Sha`, `ShaInput`, `PrRef`, `Iso`, `OneLine`, `RepoPath`, `Warning`, ids, `Author`.
  - `src/schemas/ci.ts`: `Bucket`, `Check`, `SameOnMain`, `Flake`, `FailingCheck`, `ExpectedCheck`, `CiSummary`, `FailingJob`, `CompactDiagnosis`.
- Proves: 02 §1.5, §11.9 and §12 are expressible without transforms and export to JSON Schema.
- Tests: `test/unit/schemas/common.test.ts` (boundaries in §5.1), `test/unit/schemas/ci.test.ts` (the `forHeadSha` literal; caps of 30 tests, 20 errors and 5 compact tests).

**M2.2 `feat(ci): rollup snapshot and check normalisation`**
- Files:
  - `src/ci/snapshot.ts`: the CI subset of GraphQL Q1, with the rollup-oid-equals-`headRefOid` check and one re-query (02 §4.3 step 3).
  - `src/ci/checks.ts`: CheckRun and StatusContext to `Check`; bucket mapping; collapse to the latest attempt per (workflow, name); ignore globs.
  - `src/ci/summary.ts`: `state` and `phase`; `cancelled` counts as red.
- Proves: CI is never reported for a SHA other than the head (§5.4: 175 + 150 manual SHA checks).
- Tests:
  - `test/unit/ci/checks.test.ts`: duplicate `CI duration watch` rows collapse (§6); `notify-discord` is ignored and counted in `counts.ignored`; a StatusContext maps to `kind:'status'`.
  - `test/unit/ci/summary.test.ts`: zero checks gives `no-checks`/`registering`, never `green`.
  - `test/commands/ci-snapshot.test.ts`: an oid mismatch causes one re-query, then the warning `CI_SHA_MISMATCH` and `pending`.
  - Fixtures: `gh/ci-snapshot/*` (§6.2).

**M2.3 `feat(ci): job log fetch, strip and step attribution`**
- Files:
  - `src/ci/logs/fetch.ts`: `apiText({path:'repos/{o}/{r}/actions/jobs/{id}/logs', toFile})` into `<root>/<host>/<owner>/<repo>/logs/job-<jobId>.log` (01's layout). A blob 404 gives `LOGS_NOT_READY`; a 410 gives `LOGS_UNAVAILABLE`.
  - `src/ci/logs/strip.ts`, `src/ci/logs/steps.ts`.
- Proves: logs come only from the jobs API, which works on a finished job inside a running run (§0, §3.1: 16 refusals; spike §3.3).
- Tests:
  - `test/unit/ci/logs/strip.test.ts` and `test/unit/ci/logs/steps.test.ts` (§5.1 lists the cases).
  - `test/commands/ci-logs-fetch.test.ts`: a 200 to file, a blob 404, a 410, a generic 404, and a check that the call log never contains `run view`.

**M2.4 `feat(ci): failing-test and error extraction per runner`**
- Files:
  - `src/ci/logs/extract/index.ts`: picks extractors by signature, and always runs `generic` plus `config.ci.logPatterns`.
  - `vitest.ts`, `jest.ts`, `node-test.ts`, `pytest.ts`, `go-test.ts`.
  - `generic.ts`: `##[error]`, `AssertionError`, `ERR_PNPM`, `Error:` lines and the exit line.
- Proves: §5.1's grep tokens (`FAIL` 147, `×`, `✘`, `##[error]` 9, `ERR_PNPM` 3) are absorbed into the tool.
- Tests: one file per runner, `test/unit/ci/logs/extract-<runner>.test.ts` (§5.1).

**M2.5 `feat(ci): shared-with-main comparison`**
- Files:
  - `src/ci/compare-main.ts` (02 §1.5): the default branch; the latest completed `push` run of the same workflow file with `head_sha ≠` the PR head; verdicts `same-tests`, `same-step`, `different`, `main-green` and `no-main-run`.
  - `src/core/cache.ts`: a JSON disk cache under the artifact root, with a TTL on Clock. Parsed test lists keyed by job id never expire.
- Proves: the "merge when main shares red" rule (§4.3, §7 #3246) is computed, not checked by hand (128 `run list --branch main` calls, §5.4).
- Tests:
  - `test/unit/ci/compare-main.test.ts`:
    - a job-name match with different tests gives `different`;
    - empty PR tests with equal failing steps gives `same-step`;
    - a PR test set that is a strict subset of main's gives `same-tests`;
    - no completed main run gives `no-main-run`;
    - a stacked PR compares against the default branch, not its base.
  - `test/unit/core/cache.test.ts`: TTL on FakeClock; a corrupt file counts as a miss.

**M2.6 `feat(ci): flake signals`**
- Files: `src/ci/flake.ts` (`same-sha-passed`, `main-intermittent`, `known-flaky`, `infra-error`, score, candidate). It is read-only.
- Proves: `ci wait` and `ci why` can flag rerun candidates without mutating (brief decision).
- Tests: `test/unit/ci/flake.test.ts`, covering each signal alone and the score table. The `infra-error` patterns are `ECONNRESET`, `429 Too Many Requests`, `No space left on device` and runner shutdown.

---

### M3. `ci why`

**M3.1 `feat(ci): ghx ci why <pr>`**
- Files: `src/commands/ci/why.ts`, `src/commands/index.ts`.
- Proves: a red PR is diagnosed in one call (02 §12): failing jobs, step, tests, errors, excerpt (default 20 lines, cap 60, ≤2 000 chars), log path, `sameOnMain` and `flake`.
- Tests:
  - `test/commands/ci-why.test.ts`, with scenarios:
    - `ci-why/red-vitest`, `red-shared` and `green`;
    - `external-status-fail` (lands in `nonActionsFailing`);
    - `six-failing` (`omitted: 1`, `--max-jobs`);
    - a `--job` glob;
    - 5 failing jobs at default caps stay under 16 KB.
  - `test/regression/run-view-log-refused.test.ts` (R02).
  - `test/contract/ci-why.contract.test.ts`: stdout parses with the output schema; exit 0 with `failing: []` when green; `logPath` exists on disk.

**M3.2 `feat(ci): ci why --run and misleading-green detection`**
- Files: `src/commands/ci/why.ts`, `src/ci/key-steps.ts`.
- Proves: `--run <id|url>` works without a PR, and a green job whose key step was skipped is reported (§6 misleading green; memory `trap_workflow_ui_skipped_on_prs.md`).
- Tests: `test/commands/ci-why-run.test.ts`, `test/regression/key-step-skipped.test.ts` (R19).
- Live: `test/live/ci-why.live.test.ts` (sandbox `fail.yml`).

---

### M4. `ci wait`

The protocol (02 §11.0): `ghx ci wait <pr>` runs in the background and prints one `WaitSummary` when it exits. The default mode is `first-failure`. It has no caller durations, and its state on disk makes it resumable. Every test here runs on FakeClock, so a 6-hour CI scenario takes milliseconds.

**M4.1 `feat(ci): expected-check set`**
- Files: `src/ci/expected.ts`, with three sources:
  - `required`: the union of the `rules/branches/<base>` `required_status_checks` contexts and `branches/<base>.protection.required_status_checks.contexts`, deduplicated;
  - `config`: `ci.expected`, with path filters;
  - `baseline`: the previous head, then the last merged PR, then the base head (cached).
- Proves: §3.2's spike result is used. `…/protection` is never called, and a 404 on rules gives the warning `REQUIRED_CHECKS_UNKNOWN`, not an error.
- Tests: `test/unit/ci/expected.test.ts`. Duplicate rules collapse. Org-level rulesets are included. A rules-only source and a branch-only source each work. A path-filtered `config` entry is skipped when no files match. The baseline confidence order holds.

**M4.2 `feat(ci): ETA and poll-interval math`**
- Files: `src/ci/eta.ts`, `src/ci/wait/interval.ts`.
- Proves: polling is cheap and adaptive (02 §11.6).
- Tests: `test/unit/ci/eta.test.ts`, `test/unit/ci/wait/interval.test.ts` (§5.1). The interval tests include the unattended floor of 30 s.

**M4.3 `feat(ci): conditional REST poller with GraphQL fallback`**
- Files: `src/ci/wait/poller.ts`.
  - It keeps an ETag cache per URL.
  - Each tick sends three conditional GETs: `pulls/N`, `commits/{sha}/check-runs?filter=latest&per_page=100` and `commits/{sha}/status`. A 304 reuses the cached body.
  - It falls back to GraphQL after two consecutive REST failures, and feeds `RateBudget`.
- Proves: an unchanged tick costs no rate limit (spike §3.1).
- Tests: `test/commands/ci-wait-poller.test.ts`. A 304 sequence leaves the budget unchanged. The ETag rotates on change. The poller switches to the fallback and reads `rateLimit{}`. `suggestInterval` stretches when `remaining` is under 10%.

**M4.4 `feat(ci): wait state machine`**
- Files: `src/ci/wait/machine.ts`. It's pure: `(state, snapshot, now) → {state, events[], terminal?}`. It holds the until-modes (`first-failure` by default, plus `settled` and `mergeable`), phases, grace, `expect-grace` aging, the set of already-reported failures, and the outcomes.
- Proves: every transition rule in 02 §11.1–11.3 is a pure function.
- Tests: `test/unit/ci/wait/machine.test.ts`, table-driven, one row per transition:
  - `registering` → `no-checks` exactly at the default grace (120 s);
  - `partial` never ends green;
  - a baseline check aging out emits `expected-absent`;
  - `first-failure` ends on the first failure;
  - **continuation:** with failure A already reported for this SHA, a new run stops at failure B or at settle, never at A again;
  - `cancelled` counts as red;
  - an all-shared red gives `red-shared`.

**M4.5 `feat(ci): stall detection`** (02 §11.1)
- Files:
  - `src/ci/wait/stall.ts`, pure: `(checks, jobs, baselines, timeouts, now, config) → StalledEntry[]`. Each entry is `{name, state, forSec, thresholdSec, basis}`.
  - `src/ci/wait/job-timeouts.ts`: reads `timeout-minutes` from the workflow file at the bound SHA (`GET repos/o/r/contents/<path>?ref=<sha>`, cached by blob SHA). A line scanner reads only `jobs.<id>.timeout-minutes: <int>`; anything else falls back to 360 (Q6).
  - Config key `ci.stall.queuedMinutes` (default 30).
- Proves: a wait ends early on CI-observable stalls, and every threshold is derived from baselines or from GitHub's own limits, never from the caller.
- Tests: `test/unit/ci/wait/stall.test.ts`, on FakeClock and table-driven. Each threshold is tested at −1 s (not stalled) and +1 s (stalled).

  | Case | Setup | Threshold | Expected |
  |---|---|---|---|
  | Running, short p90 | p90 = 4 min | `max(3×4m, 4m+15m)` = 19 min | `basis: "p90+15m"` |
  | Running, long p90 | p90 = 20 min | `max(60m, 35m)` = 60 min | `basis: "3×p90"` |
  | Running, crossover | p90 = 7.5 min | 22.5 min (both formulas agree) | stalled at 22.5 min + 1 s |
  | **First run, no baseline**, literal timeout | no successful runs on the base; `timeout-minutes: 45` | 45 min | `basis: "timeout-minutes"` |
  | **First run, no baseline**, no timeout | no baseline; `timeout-minutes` absent or an expression | 360 min | `basis: "default-360"`. GitHub cancels at the same moment, so `cancelled` (red) and `stalled` may race; the test pins that the first observed state wins and the outcome is deterministic per snapshot order |
  | Queued, run idle | queued with `runner_id: null`, measured from `created_at` (spike §3.5), no other job in the run started | `ci.stall.queuedMinutes` (30) | `state: "queued"` |
  | Queued, run busy | queued for 45 min, but a sibling job in the same run is `in_progress` | — | **not** stalled: a matrix waiting on its own concurrency limit is normal |
  | Queued, then runner assigned | a runner is assigned at 29 min | — | the queued clock stops; the running rules take over from `started_at` |
  | Config override | `ci.stall.queuedMinutes: 5` | 5 min | stalled at 5 min + 1 s |
  | Expected check never registers (§1 row 4, proposed) | everything else settled; a required check missing | `ci.stall.queuedMinutes` after settle | `state: "missing"` (pending Q1) |
  | Several at once | one overdue, one queued | — | both in `stalled[]`; outcome `stalled`, exit 14 |

  Also `test/unit/ci/wait/job-timeouts.test.ts`: a literal value, an expression, absent, a matrix job (the job id maps to several display names), and a reusable-workflow job.

**M4.6 `feat(ci): wait state store and resume`** (02 §11.1 resumability)
- Files: `src/ci/wait/state.ts`. State lives in the cache dir, keyed by `repo + target + boundSha`. It holds check states, the expected set, baselines, the diagnosis so far, reported failures, ETags and the terminal outcome, if any. Writes are atomic (temp file plus rename). State expires 24 h after the SHA's last check completes.
- Proves: re-running the identical command resumes at no extra cost, and a kill costs at most one extra call.
- Tests: `test/commands/ci-wait-resume.test.ts`, using FakeGh call logs:
  - **Kill mid-wait, then re-run.** Run 1 is aborted at t=10 min, after baselines, the expected set and one diagnosis. Run 2 makes no repeated baseline, ETA, expected-set, job-log or compare-main calls (`expectNoCall` on each path); its first tick uses the stored ETags (a 304); and its summary has `resumed: true`.
  - **Terminal state already known.** Run 1 finished `red` and stored it. Run 2 returns at once with the stored summary: exactly one conditional `GET pulls/N` to confirm the head is still `boundSha` (a 304), no other gh call, and no sleep on FakeClock.
  - **Head moved since run 1.** Run 2 binds the new SHA, finds no state for it, and starts fresh. The old state is left in place until it expires.
  - **Corrupt or partial state file** counts as a miss, with the warning `WAIT_STATE_DISCARDED`, and the wait starts fresh.
  - **Expiry:** state older than 24 h past the last check's completion is ignored (FakeClock).
  - **Concurrent runs:** two runs of the same target share state through a lock file in the state directory. The second run blocks on the lock until the first run ends, then returns the first run's stored summary with `resumed: true`. A stale lock, whose holder PID is gone, is broken with the warning `WAIT_STATE_DISCARDED`.
  - `test/regression/resume-after-kill.test.ts` (R21) is the contract-level version (§5.2).

**M4.7 `feat(ci): ghx ci wait <pr>` (the command)**
- Files: `src/commands/ci/wait.ts`. A stream spec with `kind:'read'`, `timeout: null` and output mode `final` (default) or `ndjson` (`--stream`). Events are always appended to `eventsPath`.
  - The summary is a `WaitSummary` with `CompactDiagnosis`, `stalled[]`, `rerunCandidates`, `diagnosisPath`, `eventsPath` and `resumed`. It is **never spilled**: for 10 targets it is compacted, with the full JSON at `diagnosisPath`.
  - **Unattended self-return:** when `CLAUDE_CODE_SESSION_ATTENDED !== "1"`, the command returns `pending` (15) after 25 min, with state saved and `next: [<the identical command>]`.
- Proves: one background call replaces sleep loops, Monitor scripts and `--watch` (§5.2: 232 + 44 + 41), and returns only on a state the agent can act on.
- Tests:
  - `test/commands/ci-wait.test.ts`, with scripted timelines on FakeClock:
    - pending → pass gives green, exit 0;
    - pending → fail gives a summary with the diagnosis folded in, exit 10;
    - a healthy 45-minute CI is followed to the end, with no stall;
    - the `mergeable` mode is added in M6.6.
  - `test/commands/ci-wait-unattended.test.ts`:
    - **env unset:** `pending`, exit 15, at exactly 25 fake minutes (not at 24:59), with state saved and `next` equal to the original argv;
    - **`CLAUDE_CODE_SESSION_ATTENDED=1`:** no self-imposed limit; a 90-minute CI runs to green;
    - **any value other than `"1"`** (`"0"`, `"true"`) counts as unattended;
    - the unattended interval floor is 30 s;
    - **pending, then re-run:** the second run resumes (`resumed: true`), with no repeated baselines.
  - **Env isolation.** This agent session itself runs with `CLAUDE_CODE_SESSION_ATTENDED=1`. So `runInProcess` and the contract helpers build `env` from scratch and never inherit `process.env`, and `test/architecture.test.ts` greps test helpers for `process.env` spreads.
  - `test/regression/no-checks-yet.test.ts` (R04), `test/regression/ci-wait-never-reruns.test.ts` (R20).
  - `test/contract/ci-wait-output.contract.test.ts` and `test/contract/ci-wait-stream.contract.test.ts` (§4.3).

**M4.8 `feat(ci): head binding and branch targets`**
- Files: `src/ci/wait/targets.ts` (`branch:<name>`, `branch:<name>@<sha>`, `--on-head-change restart|stop|stay`).
- Proves: a moved head never mixes SHAs (02 §11.5).
- Tests: `test/commands/ci-wait-head.test.ts`. `restart` re-binds under a new state key and resets grace and stall clocks. `stop` gives `superseded`, exit 12. A PR closed mid-wait gives `closed`, exit 12. A branch target emits `branch-advanced` and keeps the bound SHA.

**M4.9 `feat(ci): multiple targets and --any`**
- Tests:
  - `test/unit/ci/wait/exit-precedence.test.ts`: every pair under 02 §6.1's 10 > 14 > 13 > 12 > 15 > 11 > 0, with the list read from `exit-table.ts`.
  - `test/commands/ci-wait-multi.test.ts`: `--any` returns at the first terminal target. 10 targets, each with 5 failing jobs, give a compacted summary under 16 384 bytes that is never `spilled`, with full detail at `diagnosisPath`.
- Live: `test/live/ci-wait.live.test.ts` (§4.4.2).

---

### M5. `ci rerun` and `ci retrigger`

**M5.1 `feat(ci): ghx ci rerun <pr> [--flaky]`**
- Files: `src/commands/ci/rerun.ts`.
- Proves: only completed failing runs for the current head are rerun, within `ci.maxRerunAttempts`, and `--flaky` reruns only candidates (02 §13.1; §5.4: 44 reruns, 2 refused).
- Tests:
  - `test/commands/ci-rerun.test.ts`:
    - an in-progress run is skipped as `RUN_IN_PROGRESS`;
    - attempt 3 hits `RERUN_LIMIT`, and its override needs `--reason`;
    - `--job` posts to `jobs/{id}/rerun`;
    - `--flaky` with a `same-sha-passed` job reruns only that job, with `flake` evidence in the output;
    - `--flaky` with no candidates gives `NO_FLAKY_CANDIDATES`, exit 9;
    - `--dry-run` halts before the POST with `wouldRun`;
    - the error precedence is `NO_FAILED_RUNS` > `RUN_IN_PROGRESS` > `RERUN_LIMIT`.
  - `test/regression/rerun-already-running.test.ts` (R18, the verbatim §3.1 strings).

**M5.2 `feat(ci): ghx ci retrigger <pr>`**
- Files: `src/commands/ci/retrigger.ts`.
- Tests: `test/commands/ci-retrigger.test.ts`:
  - a deleted head branch gives `HEAD_BRANCH_MISSING` with no PATCH;
  - reopen failing 3 times gives `REOPEN_FAILED`, exit 7, with the hint to reopen in the UI;
  - no new check suites gives the warning `NO_NEW_RUNS`;
  - `AUTHOR_NOT_VIEWER` is overridable.
- Live: `test/live/ci-rerun.live.test.ts` (`flaky.yml` fails on attempt 1; `ci rerun --flaky`, then `ci wait`, gives green).

---

### M6. `pr status`, with the policy engine and feedback fold

**M6.1 `feat(meta): v1 block schemas, strict write and lenient read`**
- Files:
  - `src/meta/schemas.ts`: `PrBlock`, `ReviewBlock`, `FindingBlock`, `CommentBlock`. Strict for writes; for reads, `.passthrough()` and `Enum.or(z.string())`.
  - `src/meta/ids.ts`.
- Tests:
  - `test/unit/meta/schemas.test.ts`: a strict schema rejects unknown keys; a lenient one keeps unknown enum values and warns `UNKNOWN_ENUM`; an unknown `t` gives `kind:null` and `UNKNOWN_BLOCK_TYPE`; `ghx:v2` gives `structured:false` and `SCHEMA_NEWER`.
  - `test/unit/meta/ids.test.ts`: the Crockford alphabet with no `i l o u`, and uniqueness per PR under a seeded `Random`.

**M6.2 `feat(feedback): fold three sources with trust gate, bots and status events`**
- Files: `src/feedback/fold.ts`, `src/feedback/trust.ts`, `src/feedback/bots.ts`, and `src/feedback/events.ts` (an append-only fold ordered by `createdAt`, then `databaseId`; the last valid event wins).
- Proves: every GitHub item appears exactly once in `reviews`, `findings`, `comments` or `bots`, and nothing is dropped (brief 7; §8b: 3 sources).
- Tests:
  - `test/unit/feedback/fold.test.ts`, with a conservation invariant checked on every fixture: the count in equals the count out.
  - `test/unit/feedback/events.test.ts`.
  - `test/regression/unstructured-and-bots.test.ts` (R13), `test/regression/untrusted-block-ignored.test.ts` (R14).

**M6.3 `feat(pr): PR snapshot, mergeable retry and stack`**
- Files:
  - `src/pr/snapshot.ts`: Q1 and Q2, paginating any connection with `hasNextPage`.
  - `src/pr/mergeable.ts`: backoff of 1, 2, 3, 4, 5, 5 s, capped at 20 s (30 s for merge); restart once on a head change.
  - `src/pr/stack.ts`.
- Tests: `test/regression/mergeable-unknown.test.ts` (R03), `test/regression/auto-retarget.test.ts` (R09), and `test/unit/pr/stack.test.ts` (`declaredParent` differs from the actual parent; children are listed).

**M6.4 `feat(policy): merge policy engine`**
- Files:
  - `src/policy/merge.ts`, pure: `evaluate({pr, ci, feedback, preconditions, config, viewer, flags}) → {checks, blockers, waivers, warnings, allowed, exitClass}`.
  - `src/policy/shared-red.ts`, `src/policy/overrides.ts`.
- Proves: one engine for `pr status`, `ci wait --until mergeable` and `pr merge` (§2.1 item 4).
- Tests: `test/unit/policy/merge.test.ts` (one row per 02 §8.2 rule, §5.1) and `test/unit/policy/overrides.test.ts`.

**M6.5 `feat(pr): ghx pr status <pr>`**
- Files:
  - `src/commands/pr/status.ts`;
  - `src/pr/truncate.ts`: applies 02 §4.1's per-item caps, then drops resolved-finding bodies and the oldest comment bodies until the document is under 16 KB, counting `omitted`.
- Proves: one call answers "can it land, and what's left?" (§8a; §8b: 5–8 calls today).
- Tests:
  - `test/commands/pr-status.test.ts`:
    - the worked example (02 §14.5) is replayed from fixtures and compared field by field with the golden file `test/fixtures/golden/pr-status-3301.json`;
    - no config gives the warning `CONFIG_MISSING` plus the blocker `CONFIG_MISSING`;
    - truncation keeps the output under 16 384 bytes with `omitted > 0`.
  - `test/regression/cwd-repo-mismatch.test.ts` (R10).
  - `test/contract/pr-status.contract.test.ts`.

**M6.6 `feat(ci): ci wait --until mergeable`**
- Tests: `test/commands/ci-wait-mergeable.test.ts`. CI settles, then `mergeable` resolves, then the gate runs. A red that is all shared gives exit 11 with `merge.ready: true`. A conflict gives `red`, with `merge.blockers` holding `MERGE_CONFLICT`.

**M6.7 `feat(pr): ghx pr feedback <pr>`**
- Tests: `test/commands/pr-feedback.test.ts`. Covers `--open`, `--since <sha>`, `--include-outdated`, `--source`; bodies capped at 2 000 chars inline; the full JSON always at `artifactPath`.
- Live: `test/live/pr-status.live.test.ts`.

---

### M7. Passthrough and refusals (02 §10)

**M7.1 `feat(cli): passthrough allowlist, wrapped-command refusals, write refusals`**
- Files:
  - `src/passthrough/policy.ts`: 02 §10's table as data. It covers the allowlisted reads, the wrapped refusals (`USAGE_UNKNOWN_COMMAND` with the replacement argv), the refused writes (`PASSTHROUGH_WRITE_REFUSED`, 6) and unknown commands. Its read allowlist is the read guard's allowlist plus 02 §10's reads, and a test asserts the two never diverge.
  - `src/passthrough/run.ts`: the envelope `{passthrough:{argv, exitCode, json?, text?, stdoutPath?, stdoutBytes, stderr?}}`, `-R` injection, and an inline text cap. 02's 32 KB inline cap is lowered to fit the 16 KB global bound, with larger output going to `stdoutPath`. A non-zero gh exit gives `GH_FAILED` with the envelope in `details`.
  - Wiring through `onUnknown` in `src/cli/router.ts`.
- Proves: agents keep their unwrapped reads, and every wrapped command is refused with the exact replacement argv (§2.1, §2.4). Passthrough reads run on the read-mode gh client, so they cannot mutate.
- Tests:
  - `test/unit/passthrough/policy.test.ts`, covering every row, plus:
    - `api -f` is refused, because gh switches to POST;
    - `api graphql` is refused;
    - `run view --log-failed` gives `USAGE_UNKNOWN_COMMAND` with `details.suggestion` naming `ghx ci why`;
    - `run download` without `-D` gives `VALIDATION`.
  - `test/contract/passthrough.contract.test.ts`: the envelope shape, stderr capped at 2 KB, and `-R` injection.
  - The passthrough half of `test/regression/diff-300-files.test.ts` (R15).

---

### M8. `pr merge`

**M8.1 `feat(pr): merge plan and dry-run`**
- Files: `src/commands/pr/merge.ts`: snapshot, pinned `H`, `evaluate`, the plan, and `MERGE_BLOCKED`. The exit is 6 if any blocker is policy-class, otherwise 9.
- Tests: `test/commands/pr-merge-plan.test.ts`, `test/regression/squash-refused.test.ts` (R06), `test/regression/others-pr-refused.test.ts` (R07).

**M8.2 `feat(pr): pinned merge, failure classification, verification`**
- Files: `src/commands/pr/merge.ts`, and `src/pr/merge-put.ts`, which handles:
  - `PUT pulls/N/merge` with `{sha: H, merge_method}`;
  - a 409 → `HEAD_MOVED`;
  - a 405 → re-read → `MERGE_CONFLICT` or `BLOCKED_BY_PROTECTION`;
  - a transient error → re-read first; success with `recoveredFromTransient` if merged at `H`, else one retry;
  - a verify poll of at most 10 s.
- Tests:
  - `test/regression/merge-head-pinning.test.ts` (R01);
  - `test/regression/hidden-conflict.test.ts` (R05);
  - `test/regression/shared-red-mergeable.test.ts` (R08);
  - `test/regression/merge-transient-recovered.test.ts` (R16, #3214);
  - `test/regression/already-merged.test.ts` (R17, #3211).

**M8.3 `feat(pr): delete branch and report children`**
- Tests: `test/commands/pr-merge-branch.test.ts`:
  - a head from a fork gives a warning and no DELETE;
  - a head that is another PR's base is not deleted;
  - `children` is listed;
  - `next` holds `ghx ci wait branch:<default>@<mergeCommit>`.
- Live: `test/live/pr-merge.live.test.ts`, including the moved-head race (§4.4.3).

---

### M9. `pr create`

**M9.1 `feat(pr): create input schema and validation rules`**
- Files: `src/pr/create/schema.ts`, `src/pr/create/rules.ts` (`createRules`; collects all issues).
- Tests: `test/unit/pr/create-rules.test.ts`, with one pass and one fail boundary per rule in 02 §2.1 (§5.1).

**M9.2 `feat(render): PR body renderer`**
- Files: `src/render/pr-body.ts` (description, trailer, footer and block; `trailer` and `details` modes).
- Tests: `test/unit/render/pr-body.test.ts`, with golden files (§5.1).

**M9.3 `feat(pr): ghx pr create`**
- Files: `src/commands/pr/create.ts`: preflight GraphQL; compare with the 300-file fallback; the local head check; POST via `--input -`; read-back.
- Tests:
  - `test/commands/pr-create.test.ts`:
    - draft is derived from the base;
    - the stack is auto-detected;
    - `DUPLICATE_PR` (exit 6) comes from the preflight and from a 422 race;
    - after a transient POST failure, the open-PR query re-runs before any retry;
    - `HEAD_DIFFERS_FROM_LOCAL`;
    - a missing `--input` gives `USAGE_INPUT_MISSING`, exit 2.
  - `test/regression/title-drift.test.ts` (R11), and the `pr create` half of R15.

**M9.4 `feat(pr): pr create --batch`**
- Tests: `test/commands/pr-create-batch.test.ts`:
  - items are ordered topologically, and a cycle gives `VALIDATION`;
  - every item is preflighted before the first POST;
  - a mid-batch failure gives `PARTIAL_FAILURE` (exit 7) with `created`, `failed` and `notAttempted`;
  - a title of `$2` stays literal.
- Live: `test/live/pr-create.live.test.ts`.

---

### M10. `pr edit`

**M10.1 `feat(pr): ghx pr edit`**
- Files: `src/commands/pr/edit.ts`.
- Tests:
  - `test/regression/body-edit-preserves-block.test.ts` (R12).
  - `test/commands/pr-edit.test.ts`:
    - the draft toggle goes through GraphQL `markPullRequestReadyForReview`;
    - a base retarget re-runs the stack checks and warns `HAS_CHILDREN`;
    - an empty patch gives `VALIDATION`.

---

### M11. `pr comment`, `pr review`, `pr resolve`

**M11.1 `feat(pr): ghx pr comment`**
- Tests:
  - `test/unit/render/comment.test.ts` (goldens).
  - `test/commands/pr-comment.test.ts`: `--close` with a precondition is refused; `supersede` without `--close` warns `SUPERSEDED_STILL_OPEN`; a ref to this same PR is refused.

**M11.2 `feat(pr): ghx pr review`**
- Files: `src/commands/pr/review.ts`, `src/review/hunks.ts` (parses `patch` hunks per side).
- Tests:
  - `test/unit/review/hunks.test.ts`: a line inside, at the edge of, and outside a hunk; LEFT and RIGHT sides; a file with no `patch` is body-only.
  - `test/unit/pr/review-rules.test.ts`.
  - `test/commands/pr-review.test.ts`:
    - a self-review posts `COMMENT` with `verdictDowngraded`;
    - a stale `--expect-head` gives `HEAD_MOVED`, exit 9;
    - a 422 gives `REVIEW_REJECTED` (exit 7), with no silent retry;
    - comment ids map back to finding ids.

**M11.3 `feat(pr): ghx pr resolve`**
- Tests: `test/commands/pr-resolve.test.ts`:
  - `addressed` needs a commit reachable from the head and not from the base;
  - an inline finding gets a thread reply, then `resolveReviewThread`, and a failed resolve only warns `THREAD_RESOLVE_FAILED`;
  - setting the same status again gives `ALREADY_IN_STATUS`, with nothing posted.
- Live: `test/live/feedback.live.test.ts` (review, then resolve, then `pr status` shows the finding addressed).

---

### M12. Agent docs, steering and acceptance

**M12.1 `docs(agents): CLAUDE.md snippet, skill, hooks guide`** (01 commit 15), with `pnpm docs:gen` and the staleness test `test/docs.test.ts`.
- The snippet carries 02 §11.0's protocol sentence verbatim. `test/docs.test.ts` asserts the exact string, so the canonical protocol can't drift.
- The same sentence is the `description` of `ghx ci wait --help` from M4.7 on, so agents see it before M12 lands.

**M12.2 `feat: ghx hook claude-pretooluse`** (01 commit 16, extended by 02 §11.0 "Enforcement").
- Files:
  - `src/commands/hook.ts`, with matcher `Bash|Monitor` in the documented settings;
  - `src/hook/rules.ts`, pure: `(event) → HookOutput | null`.
- Behaviour:
  - A Bash call whose command starts with `ghx ci wait` and lacks `run_in_background: true` gets `{hookSpecificOutput:{hookEventName:"PreToolUse", updatedInput:{...tool_input, run_in_background:true}}}`, with **no** `permissionDecision` (spike §3.6).
  - A `Monitor`, or a Bash loop, polling gh CI gets the soft (ask) response naming `ghx ci wait <pr>` with `run_in_background`.
  - The existing `replaces` nudges are unchanged.
- Tests: `test/commands/hook.test.ts`, run against the event fixtures in `test/fixtures/hook/` (shapes from spike §3.6).
  - **The `run_in_background` rewrite:**
    - `bash-ci-wait-foreground.json` gives `updatedInput` equal to the input plus `run_in_background:true`, with `command`, `description` and any other field preserved byte for byte, no `permissionDecision`, and no `permissionDecisionReason`.
    - `bash-ci-wait-background.json` (already `true`) gives no output.
    - `ghx ci wait` with leading whitespace or an env prefix is rewritten. `cd x && ghx ci wait 1` is not (prefix match only), and `ghx ci why 1` is not.
    - `GHX_HOOK_MODE=off` gives no output.
  - **Monitor-loop detection:**
    - `monitor-gh-checks-loop.json` (`while true; do gh pr checks 3266 …; sleep 30; done`), `monitor-run-watch.json` and `bash-until-gh-run-list.json` each give `permissionDecision:"ask"`, with a reason containing `ghx ci wait 3266` and `run_in_background`. The PR number comes from the command when present, else `<pr>`.
    - `monitor-unrelated.json` (`tail -f build.log`) gives no output.
    - A single, non-looping `gh run view 123` in Monitor gets only the ordinary `replaces` nudge.
  - **Fail-open:** bad JSON on stdin, an unknown `tool_name`, or a missing `tool_input` each give exit 0 and no output. Latency stays under 100 ms with no gh call.
  - Every `replaces` pattern still matches §2.1-style commands, including piped ones such as `gh pr checks 3198 | awk …`.
- Live check: `scripts/spike-hook.ts` (M0.3) runs the real hook binary in place of the throwaway one and asserts a `ghx ci wait` foreground call comes back as `Command running in background`.

**M12.3 `docs(agents): permissions.deny rules for raw gh writes`**: `docs/agents/hooks.md` gains the settings block (brief decision: opt-in).

**M12.4 `test(acceptance): scripted agent session and scorer`**: `scripts/acceptance/*` (§8.2).

---

## 3. Spike results (2026-10-22, gh 2.86.0, Claude Code 2.1.280)

All gh probes (§3.1–3.5) were read-only, and they are kept in `scripts/spike-gh.ts` (M0.1). The hook probe (§3.6) is kept in `scripts/spike-hook.ts` (M0.3).

### 3.1 ETags and 304 via `gh api -i`

```sh
E=$(gh api -i repos/cli/cli | grep -i '^etag:' | sed 's/^[Ee]tag: //' | tr -d '\r')
gh api -i -H "If-None-Match: $E" repos/cli/cli; echo "exit=$?"
```

**Result.**
- `HTTP/2.0 304 Not Modified`. The headers still print on stdout (1 240 bytes, empty body). stderr is `gh: HTTP 304`, and the **exit code is 1**.
- `X-Ratelimit-Used` stayed at 79 across three 304s; the next 200 made it 80. So **304s are free**.
- This also works on `commits/{sha}/check-runs?filter=latest&per_page=100`, `commits/{sha}/status` and `pulls?per_page=1`.
- GitHub sends a weak `W/"…"` ETag on the 200 and a strong one on the 304. Sending either back verbatim gives a 304.

**Design.** Keep the primary conditional-REST path (02 §11.6).
- `api.ts` treats `exit 1 ∧ status 304 ∧ If-None-Match sent` as `{notModified: true}` and returns the cached body. It never retries a 304.
- The ETag cache stores whatever ETag came back last.
- *If a future gh stops printing headers on non-2xx:* detect the stderr `gh: HTTP 304` instead.
- *If 304s ever start counting:* the GraphQL fallback, with `rateLimit{cost}`, becomes primary. The change stays inside `poller.ts`.

### 3.2 Rules and branch endpoints without admin

```sh
gh api repos/cli/cli/rules/branches/trunk
gh api repos/cli/cli/branches/trunk --jq '{protected, protection}'
gh api repos/cli/cli/branches/trunk/protection
```

**Result.** Both endpoints are readable without admin.
- **`rules/branches`** gives 200 on cli/cli, and also on `powerhouse-inc/powerhouse`, where the user has `maintain` but not `admin` (it returns `[deletion]` there).
- **`branches/<b>`** gives 200 with `protection.required_status_checks.contexts`. cli/cli lists 3 `build (…)` checks; powerhouse lists none.
- **The admin-only `…/protection`** returns **404, not 403**.
- **Rule lists can repeat entries** (microsoft/vscode lists `deletion` twice) and include org-level rulesets (`ruleset_source_type`).
- **No sampled repo had a `required_status_checks` *ruleset* rule.** The repos were cli/cli, powerhouse, nodejs/node, microsoft/vscode and facebook/react. So the rule's shape (`parameters.required_status_checks[].context`) comes from the REST docs. It is tested on a synthetic fixture and re-captured from the sandbox ruleset.

**Design.**
- `required` = the deduplicated union of both endpoints. `…/protection` is never called.
- A 404 on `rules/branches` (a missing branch, or a GHES without rulesets) gives an empty source plus the warning `REQUIRED_CHECKS_UNKNOWN`. `isRequired` on reported checks still applies.
- *If a future org setting hides rulesets from non-admins:* `required` degrades to the branch summary plus `isRequired`, and `config.ci.expected` is the documented way to declare checks.

### 3.3 Job-logs redirect

```sh
gh api -i repos/cli/cli/actions/jobs/119137909038/logs            # completed failed job
gh api -i repos/vercel/next.js/actions/jobs/119889011890/logs     # finished job, run still in progress
gh api -i repos/nodejs/node/actions/jobs/119888519187/logs        # job still running
gh api -i repos/cli/cli/actions/jobs/73871539329/logs             # job from before 2026-05
```

**Result.**
- **The redirect is followed.** `-i` shows only the final Azure Blob response:
  - `HTTP/1.1 200 OK` and `Server: Windows-Azure-Blob/1.0`;
  - CRLF header lines, and **no GitHub `X-Ratelimit-*` headers**;
  - a body that starts with a **UTF-8 BOM** and contains `##[group]`, `##[endgroup]` and `##[error]Process completed with exit code 1.`
- **A finished job inside a running run gives 200** with its log, while `gh run view <run> --log` and `--log-failed` both refuse with `run … is still in progress`. This confirms the G-LOGS path.
- **A job that is still running** (and also a skipped job) gives:
  - `HTTP/1.1 404 The specified blob does not exist.`;
  - an XML `<Code>BlobNotFound</Code>` body;
  - stderr `gh: HTTP 404`, exit 1.
- **Expired logs** give `HTTP/2.0 410 Gone`, stderr **`gh: Server Error (HTTP 410)`**, exit 1. 01's classifier would call that transient because of the "Server Error" text.

**Design.**
- `fetch.ts` streams to a file and strips the BOM.
- The header parser accepts `HTTP/1.1` and leaves the rate budget untouched when no rate headers are present.
- A blob 404 gives `LOGS_NOT_READY`. `ci why` returns `logPath:null` plus that warning, and `ci wait` fetches again once the job completes.
- A 410 gives `LOGS_UNAVAILABLE`, and its classifier row sits before `GH_TRANSIENT`.
- A GitHub JSON 404 (`{"message":"Not Found"}`) means the job doesn't exist (`RUN_NOT_FOUND`).
- *If gh ever stops following the redirect:* `api.ts` reads `Location` from the 302 and fetches it with a plain `fetch()`. The URL is pre-signed, so no auth is sent. That would be the only network call outside gh (Q4).

### 3.4 Extra: GraphQL partial errors

```sh
gh api -i graphql -f query='{repository(owner:"cli",name:"cli"){pullRequest(number:99999999){number}} rateLimit{remaining cost}}'
```

**Result.**
- `HTTP/2.0 200 OK`, but **exit 1**.
- stdout holds both `data` (`pullRequest: null`) and `errors[{type:"NOT_FOUND", path, message}]`.
- The headers include **duplicate** `X-Ratelimit-Resource` lines, plus a new `Ratelimit-Remaining`.

**Design.** `graphql.ts` parses stdout first and classifies by `errors[].type`. It keeps `data` for partial results, such as an alias for one missing precondition ref. The header parser keeps the last of any duplicate header.

### 3.5 Extra: job fields for stall detection

```sh
gh api "repos/vercel/next.js/actions/runs/<queued run>/jobs" --jq '.jobs[] | select(.status=="queued") | {created_at,started_at,runner_id,runner_name}'
```

**Result.**
- A queued job has `runner_id: null` and `runner_name: null`, and its **`started_at` already equals `created_at`**.
- A running job has `runner_id` and `runner_name` set.
- No jobs-API field carries `timeout-minutes`.

**Design.**
- The queued rule in 02 §11.1 is `status == queued ∧ runner_id == null`, measured from `created_at`. Using `started_at` would make every queued job look as if it had just started running.
- The "no other job in its run has started" condition reads the same jobs list: any sibling with a `runner_id` or `status ≠ queued` counts as started.
- `timeout-minutes` comes from the workflow file (M4.5, Q6).

### 3.6 Claude Code hook: `updatedInput` without a permission decision (Claude Code 2.1.280)

This spike used a throwaway PreToolUse hook (`hook.mjs`, which logs its input and emits a rewrite) wired through a scratch `--settings` file in a temp directory. The user's settings were not touched.

```sh
claude -p "<run: echo GHXSPIKE-A (foreground); then echo GHXSPIKE-B>" \
  --settings ./settings.json --allowedTools "Bash(echo:*)" --output-format stream-json --verbose
```

**Result.**

| Probe | Hook output | Observed |
|---|---|---|
| A: set a non-`command` field | `updatedInput: {...tool_input, run_in_background: true}`, no `permissionDecision` | **Honoured.** The tool result was `Command running in background with ID: …`, and a `task_notification` followed on completion. The model had not asked for background |
| B: rewrite `command` | `updatedInput: {...tool_input, command: "echo GHXSPIKE-B-rewritten"}`, no decision | **Honoured.** The tool result was `GHXSPIKE-B-rewritten`. The stream-json `tool_use` event still shows the model's *original* input |
| C: rules still apply | Rewrite to `touch <scratch>/should-not-exist` under a scratch `permissions.deny: ["Bash(touch:*)"]` | **Denied:** "Permission to use Bash with command touch … has been denied", and the file was not created. So `updatedInput` without a decision does not auto-allow; permission rules run on the rewritten input |
| D: Monitor matcher | Matcher `Bash\|Monitor`, log only | The hook fired for Monitor. Its `tool_input` is `{command, description, timeout_ms}` |

**Design.**
- The 02 §11.0 rewrite works as specified, so the "deny with the exact call" fallback is not needed on 2.1.280.
- The acceptance scorer (§8.2) can't trust the `tool_use` event for `run_in_background`, because that event shows the pre-rewrite input. It uses the `tool_result` text (`Command running in background`) and the `task_notification` events instead.
- Because the behaviour is version-dependent, `scripts/spike-hook.ts` (M0.3) re-checks it after each Claude Code upgrade.
- Observed side fact: this agent session runs with `CLAUDE_CODE_SESSION_ATTENDED=1`. That is why the tests isolate the environment (M4.7).

---

## 4. Test architecture

### 4.1 Unit tests

Unit tests cover pure modules. They make no gh calls and run in-process on `node:test`. Their case lists are in §5.1.

Rules:
- Every zod schema at a boundary has a boundary test.
- Time comes from `FakeClock`, and randomness from a seeded `Random`.
- Golden files are rewritten only with `UPDATE_GOLDEN=1`. `test/golden.test.ts` fails if that variable is set while `CI=true`.
- Coverage: `node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-include='src/{ci,policy,meta,feedback,pr/create,render}/**'` runs on the Linux CI job.

### 4.2 The fake gh (in-process)

`test/helpers/fake-gh.ts` produces a `ProcessRunner` for `createGh({proc})`, so commands run exactly as in production, down to the spawn.

```ts
export interface GhReply {
  exitCode: number; stdout: string; stderr: string;
  stdoutFile?: string;            // fixture-relative; copied to req.stdoutFile (logs)
  delayMs?: number;               // resolved on FakeClock
  hang?: true;                    // never resolves until req.signal aborts
}
export interface GhFixture extends GhReply {
  argv: string[];                 // without 'gh'
  stdin?: { json: unknown } | { text: string };   // matched for writes
  meta: { source: 'live:sandbox' | 'live:public' | 'synthetic' | 'corpus-shape';
          recordedAt?: string; ghVersion?: string; note?: string };
}
export type ArgvMatcher = string[] | { prefix: string[] } | ((argv: string[], stdin?: string) => boolean);

export class FakeGh {
  static fromScenario(dir: string): FakeGh;                       // test/fixtures/gh/<dir>/*.json; file order = reply order per argv
  on(m: ArgvMatcher, reply: GhReply | GhReply[]): this;           // array = successive calls; last one repeats
  timeline(clock: FakeClock, steps: { atMs: number; on: [ArgvMatcher, GhReply][] }[]): this;
  runner(): ProcessRunner;
  readonly calls: { argv: string[]; stdin?: string; env: Record<string, string | undefined>; at: number }[];
  expectCalls(expected: ArgvMatcher[], o?: { ordered?: boolean; exhaustive?: boolean }): void;
  expectNoMutations(): void;                                       // via src/gh/guard.ts isMutating
  expectNoCall(m: ArgvMatcher): void;                              // e.g. ['run','view'] for R02
  assertAllConsumed(): void;
}
```

- **Canonical argv** (`fixture-match.ts`). `-R/--repo` values are normalised to `host/owner/name`, `-H` and `-F/-f` pairs are sorted, and `--include` is kept, since ghx always sends it to `api`. An unmatched call throws `FakeGhUnmatched`, listing the three nearest fixtures by edit distance. A test never silently gets an empty reply.
- **Scripted timelines.** For `ci wait`, `timeline()` picks the reply set with the latest `atMs` that is ≤ `clock.monotonic()`. A test reads like a story, e.g.:
  - t=0: nothing reported;
  - t=45 s: 9 pending;
  - t=4 m: Typecheck passes;
  - t=14 m: shard 1 fails.

  `FakeClock.runUntil(() => done)` drives the poll loop, so a 45-minute wait or a 360-minute stall takes milliseconds.
- **Assertions on intent.** Each command test ends with `expectCalls` (ordered, for writes), and every read-command test calls `expectNoMutations()`. `test/registry.test.ts` repeats the second check generically for every `kind:'read'` spec (01 §3.8). This is how "ci wait flags flaky jobs but never reruns them" is enforced.
- **Harness.** `runInProcess(argv, {gh: FakeGh, clock, env, cwd, git})` (01's `harness.ts`) returns `{stdout, lines, json, exitCode, calls}`. `git` is a separate small fake, `test/helpers/fake-git.ts`, covering remotes, toplevel and `rev-parse`, so the cwd/repo cases need no real repo.

### 4.3 CLI contract tests

These spawn `node bin/ghx.js` with:
- `PATH=test/fixtures/bin:$PATH`;
- `GHX_FAKE_SCENARIO=<dir>`, `GHX_FAKE_LOG=<tmp>/calls.ndjson` and `GHX_FAKE_STATE=<tmp>`;
- `GHX_ARTIFACT_DIR=<tmp>/art`.

The fake `test/fixtures/bin/gh` is a Node script that imports `test/helpers/fixture-match.ts`.
- Successive replies across processes use a counter file in `GHX_FAKE_STATE`.
- A `hang` reply blocks until killed.
- Every call is logged with its argv, `stdinSha256` and the env keys ghx is meant to set.

The exit codes are imported from `test/contract/exit-table.ts`.

| File | Asserts |
|---|---|
| `output-shape.contract.test.ts` | For every command, a success scenario's stdout parses with that command's output schema (from `ghx <cmd> --schema`, checked by a small JSON Schema validator in `test/helpers/jsonschema.ts`). Error scenarios parse as `{error:{code,message,hint,details}}`, with all four keys present and `null` when empty |
| `exit-codes.contract.test.ts` | Table-driven: one scenario per row of 02 §6.1 (0–15, 130, 143), each asserting both the exit code and `error.code` or `summary.outcome`. Exit 1 comes from a forced output-contract bug in a test-only command. Exit 14 comes from a stall scenario whose fake job timestamps are already past the threshold. Exit 15 comes from a run with `GHX_TEST_CLOCK_OFFSET_MS`, which is honoured only under `GHX_TEST_HOOKS=1` and starts the wait 25 min "into" its elapsed time, so the self-return happens at once in real time |
| `ci-wait-output.contract.test.ts` | **The default protocol.** stdout is **exactly one JSON document**: the whole stdout passes a single `JSON.parse` with only a trailing newline, and it validates as `WaitSummary`. It is never `{spilled:…}`. With **10 targets, each with 5 failing jobs**, stdout is under 16 384 bytes, and `diagnosisPath` and `eventsPath` exist and parse (the events file as NDJSON with gapless `seq`). **SIGTERM mid-wait** (the fake gh's poll replies `hang`) gives one document with `outcome:"interrupted"`, exit 143; SIGINT gives 130; a second signal inside the 3 s grace still produces the document. A fatal gh error mid-wait gives one `{error:…}` document, exit 7. **No default deadline:** with no flags and a fake CI that stays healthy and pending, the process is still running after 5 real seconds and has written nothing to stdout yet; a SIGTERM then gives the `interrupted` summary. The spawned env omits `CLAUDE_CODE_SESSION_ATTENDED` unless a case sets it |
| `ci-wait-stream.contract.test.ts` | `--stream`: every line is JSON with `type`, `seq` (0, 1, 2, … with no gaps) and `at`. There is exactly one terminal line, `summary` or `error`, and it comes last; the same holds under SIGTERM. Non-terminal lines are ≤4 096 bytes. The lines are identical to the `eventsPath` file |
| `ci-wait-resume.contract.test.ts` | Spawn `ghx ci wait`, wait for the first fake-gh call after the baseline calls, then **SIGKILL** the process (no graceful path). Re-run the identical command against the same `GHX_FAKE_STATE` and cache dir. The fake gh log shows no second baseline, expected-set or job-log call, and the summary has `resumed:true`. A third run, after the scenario reaches a terminal state, makes exactly one conditional `GET pulls/N` and exits within 2 s with the stored outcome |
| `spill.contract.test.ts` | `--max-bytes 2000` on `pr status` prints `{spilled:true,path,bytes,command}` with exit 0. The file at `path` parses and is `bytes` long. `GHX_MAX_BYTES` is honoured. Without the flag, the worked example stays inline |
| `stdin.contract.test.ts` | **No implicit stdin read.** Spawn with `stdio: ['pipe', …]` and never write to or close stdin. `ghx pr status 1` completes within 5 s (fake gh). `ghx pr create` without `--input` returns `USAGE_INPUT_MISSING` (exit 2) within 5 s. `--input -` reads the pipe once it closes. A stdin of 1 MiB + 1 byte gives `USAGE_INPUT_JSON` with a size message |
| `flush.contract.test.ts` | macOS pipe flush (01 §3.5): a test-only command writes 1 MiB of NDJSON. The reader gets every byte, including the final newline. Runs on both CI OSes |
| `env.contract.test.ts` | The fake gh saw `GH_PROMPT_DISABLED=1`, `GH_PAGER=`, `NO_COLOR=1` and `GH_NO_UPDATE_NOTIFIER=1`, and no `GH_FORCE_TTY`. Every gh argv carries an explicit repo (`-R` or `repos/o/r/…`); no call relies on cwd inference |
| `passthrough.contract.test.ts` | The envelope shape; `-R` injection; `USAGE_UNKNOWN_COMMAND` with `details.suggestion` for wrapped commands; refusal of writes and `api -f`; edit-distance suggestions for unknown commands |
| `help-schema.contract.test.ts` | `ghx --help` is JSON under 4 KB. `ghx <cmd> --schema` makes no gh calls (the fake gh log stays empty). `--schema` for `ci wait` reports `kind: "read"`. `ghx ci wait --help` contains the 02 §11.0 protocol sentence verbatim |
| `no-gh.contract.test.ts` | With no gh on `PATH`, every command returns `ENV_GH_MISSING` (exit 4), and `ghx doctor` reports it |

### 4.4 Live tests (opt-in)

`pnpm test:live` runs `test/live/*.live.test.ts` only when `GHX_LIVE=1` and `GHX_SANDBOX_REPO=<owner>/<name>` are set. `test/live/guard.ts` refuses to run unless both hold:
- the repo name ends in `-sandbox`;
- the token reaches no other repo (it checks `gh api user/repos`, using a fine-grained token scoped to the sandbox).

These tests are never part of `pnpm test` or the default CI.

#### 4.4.1 The sandbox repo (`test/sandbox-template/`, pushed by `scripts/sandbox/init.ts`)

| Path | Purpose |
|---|---|
| `.github/ghx.json` | Components `app`, `lib`, `docs` and `ci`. `ci.ignore: ["notify-noise"]`. `ci.keySteps: ["Run tests"]`. `merge.method: merge`. `ci.expected: [{name: "docs-check", paths: ["docs/**"]}]`. `ci.stall.queuedMinutes: 3`, so the queued-stall live case finishes in minutes rather than 30 |
| `ci/mode.json` | `{"fail": "none" \| "vitest" \| "jest" \| "node-test" \| "pytest" \| "go" \| "all", "slowSeconds": 0, "stuck": false}`. A branch changes CI behaviour by committing this file, so every scenario is one commit |
| `.github/workflows/pass.yml` | One job, `pass`, about 20 s. **Required by a ruleset** on `main` (exercises the `required` source and the ruleset fixture) |
| `.github/workflows/fail.yml` | A matrix over vitest, jest, `node --test`, pytest and `go test`. Each has one deterministic failing test named `ghx sandbox fails on purpose (<runner>)`, switched on by `ci/mode.json`. Sources: `app/{vitest,jest,node-test}/…`, `py/test_sandbox.py`, `go/sandbox_test.go`. This is where the per-runner log fixtures come from |
| `.github/workflows/flaky.yml` | Fails when `github.run_attempt == 1`, passes on rerun (`same-sha-passed`, `ci rerun --flaky`) |
| `.github/workflows/slow.yml` | Sleeps `slowSeconds`, with `timeout-minutes: 40`. On `main` it takes about 20 s, so p90 is about 25 s and the running-stall threshold is `max(3×p90, p90+15m)` ≈ 15.4 min. A PR with `slowSeconds: 1200` crosses that threshold before GitHub's 40-minute cancel, giving `stalled` (running) |
| `.github/workflows/stuck.yml` | When `stuck: true`, it runs a single job with `runs-on: [self-hosted, ghx-no-such-runner]`, alone in its run. The job stays queued with `runner_id: null` and no sibling started, which gives `stalled` (queued) after `ci.stall.queuedMinutes`. The live test cancels the run in cleanup |
| `.github/workflows/late.yml` | `workflow_run` on `pass.yml`: a late-registering check (`partial` phase) |
| `.github/workflows/docs.yml` | Path-filtered on `docs/**` (baseline aging; `ci.expected` with paths) |
| `.github/workflows/noise.yml` | A job `notify-noise`, always skipped (noise filtering) |
| `.github/workflows/key-step.yml` | A green job whose `Run tests` step is skipped (misleading green, R19) |
| `.github/workflows/bot-comment.yml` | On `pull_request`, posts a comment starting with `<!-- ci-duration-watch -->` as `github-actions[bot]` (bot separation, R13) |
| Repo settings (manual, user) | Merge commits **and** squash enabled, which proves `METHOD_NOT_ALLOWED` is ghx policy rather than GitHub's. A ruleset requiring `pass` on `main`. Actions enabled. Default log retention |
| State of `main` | `ci/mode.json` on `main` has `fail: "vitest"` during the shared-red case. A setup step sets it per run and restores it afterwards |

The live workflow needs one secret, `GHX_SANDBOX_TOKEN`: a fine-grained token for the sandbox only, with read/write on contents, pull requests and actions. `GHX_SANDBOX_OTHER_TOKEN` is optional, for a second account (Q2).

#### 4.4.2 Live cases

Each case pushes its own branch, `ghx-live/<runId>/<case>`, from a temp clone. Its `after()` closes the PR, cancels any runs still going and deletes the branch.

| File | Flow |
|---|---|
| `ci-why.live.test.ts` | A branch with `fail: "all"` and a PR. `ci wait --until first-failure` gives exit 10, with a diagnosis per runner carrying the right test names. `ci why` agrees |
| `ci-wait.live.test.ts` | All waits are spawned the way the agent runs them: in the background, reading only stdout and the exit code. Pass only: exit 0, stdout a single `WaitSummary`. `stuck: true`: `stalled` (queued), exit 14, after about 3 min. A `[skip ci]` commit: exit 13 after the 120 s grace. **Resume:** SIGKILL after the first check registers, re-run, and the summary has `resumed: true` with the same final outcome. **Unattended:** the environment variable is unset, but the wait is short, so no `pending`. Slow tier (`GHX_LIVE_SLOW=1`, about 20 min): `slowSeconds: 1200` gives `stalled` (running), exit 14, with `basis: "p90+15m"` |
| `ci-rerun.live.test.ts` | `flaky.yml` fails; `ci rerun --flaky` reruns it; `ci wait` then gives green, with `same-sha-passed` visible in `ci why` on the old attempt |
| `pr-status.live.test.ts` | Shared red (main fails the same vitest test): `merge.ready: true` with a `CI_RED` waiver. The bot comment is in `bots[]` |
| `pr-create.live.test.ts` | Create from JSON. The read-back title and body equal the rendered ones byte for byte. A batch of 3 is stacked, with the stacked items as drafts |
| `feedback.live.test.ts` | A review with one inline and one body-only finding (a self-review, so posted as `COMMENT`). Then a resolve. `pr status` then shows `addressed` with `verified: true` |
| `pr-merge.live.test.ts` | `--method squash` is refused. A dry run is allowed. The **moved-head race** (§4.4.3). Then a real merge with `merge_method: merge`, verified, whose `next` holds `ci wait branch:main@<sha>` |

#### 4.4.3 The moved-head race

A stale `--expect-head` is caught by the snapshot before the PUT, so it doesn't prove server-side pinning. To force a real race, the gh layer has one test seam: when `GHX_TEST_HOOKS=1` and `GHX_TEST_BARRIER=<path>` are set, the first **mutating** call writes `<path>.ready`, then waits (Clock-polled, at most 60 s) for `<path>.go`.

The live test:
1. starts `ghx pr merge <ref>` in the background;
2. waits for `.ready`, then pushes a new commit to the head;
3. creates `.go`;
4. asserts `HEAD_MOVED` (exit 9) from the server's 409, and that the PR is still open.

`architecture.test.ts` asserts the barrier is referenced only in `src/gh/index.ts`. `test/contract/barrier.contract.test.ts` asserts it does nothing without `GHX_TEST_HOOKS=1` (Q3).

---

## 5. Test case catalogue

### 5.1 Unit test cases by module

**Schemas (02 §1.5, §2.1, §7): one pass and one fail boundary per rule.** File: `test/unit/pr/create-rules.test.ts` unless noted.

| Rule | Pass | Fail |
|---|---|---|
| `title.format` | `feat(reactor)!: x` | `Feat(reactor): x`, `feat(reactor) x`, `feat(): x` |
| `title.too_long` | 72 code points, including one emoji counted as 1 | 73 code points |
| `title.scope_missing` | `fix(reactor): x` with `scopeRequired: true`; `fix: x` with `false` | `fix: x` with `true` |
| `title.multi_scope` | — | `feat(codegen,vetra): x` (§4.1) |
| `title.scope_not_component` / `scope_not_declared` | scope in config and in `components` | not in config; or in config but not in `components` |
| `title.pr_suffix` | `fix(x): handle #12 edge` | `fix(x): y (#2894)` |
| `title.whitespace` / `trailing_period` | `fix(x): a b` | ` fix(x): a`, `fix(x): a  b`, `fix(x): a.` |
| `title.revert_needs_ref` | `revert(x): y` with `refs.reverts` | without it |
| `description.lines` | 3 lines | 4 lines; 2 lines with a blank line between |
| `description.too_long` | 500 chars | 501 chars |
| `description.markdown_structure` | `#3184 merged first, so …` (§1 row 12); `-1 is the sentinel` | each of `# H`, `- a`, `* a`, `+ a`, `1. a`, `> a`, `\| a`, a fence, `<details`, `<!--` |
| `description.footer` | — | contains `🤖 Generated with`; contains `ghx:` |
| `testing.min_pass` | one `pass` | all `not-run` (with notes) |
| `testing.command_required` / `steps_required` | `unit` with a command; `manual` with 1 step | `unit` without a command; `manual` with 0 or 6 steps |
| `testing.not_rerunnable` | `./scripts/t.sh`, `/usr/bin/env node t.js` | `/Users/x/…`, `/home/x`, `/tmp/a`, `/private/tmp/a`, `~/x`, `C:\x` |
| `testing.compound_command` | `pnpm test -- -t "a\|b"` (quoted pipe) | `pnpm test \| tail`, `a && b`, `a; b`, `a > f`, `` `x` ``, `$(x)`, `a 2>&1` |
| `testing.notes_required` | `fail` with notes | `skipped` without notes |
| `testing` count | 1 and 10 items | 0 and 11 |
| `testing[i].cwd` | `packages/reactor` | `../x`, `/abs` |
| `OneLine(200)` | 200 chars | 201 chars; contains `\r` |
| `risk.note_required` | `low` without a note; `medium` with one | `high` without a note |
| `risk.below_component_floor` | `medium` with floor `medium` | `low` with floor `medium` |
| `revert.note_required` / `with_required` | `revert-safe` alone; `coordinated` with 1 ref | `forward-fix-only` without a note; `coordinated` with `[]` |
| `components` | 1 and 5, unique | 0, 6, a duplicate |
| `base.equals_head` | — | `base == head` |
| `refs.stacked_on_default_base` | `stackedOn` with a non-default base | `stackedOn` with the default base |
| `PrRef` (`common.test.ts`) | `#1`, `o/r#12`, `o.x/r-y#3` | `#`, `o/r#`, `#0`, `3198`, `pr-3198` |
| `ShaInput` | 7 and 40 lowercase hex chars | 6 and 41; uppercase (the hint says to lowercase it) |
| ids | `p_k3m9qa` | `p_k3m9qi` (contains `i`), `x_abcdef`, 5 chars |
| `reviewRules` (`review-rules.test.ts`) | `approve` with a low finding; `request-changes` with 1 finding | `approve` with a high finding; `request-changes` with 0; `endLine < line`; a duplicate (path, line, title) |
| `PrCommentInput` (`comment.test.ts`) | `note` with 15 lines and 1 500 chars | 16 lines; 1 501 chars; a body containing `<!-- ghx:` |
| `--note` on `pr resolve` (`resolve.test.ts`) | 200 chars, one line | 201 chars; a newline |
| Config (`config/schema.test.ts`, 01 commit 11) | `{version:1, components:{x:{}}}` comes out fully populated via prefault | `componets` (suggests `components`); `merge.method` not in `allowedMethods`; an invalid glob |

**Hidden-block codec** (`test/unit/meta/codec.test.ts`):
- **Round-trip** of strings containing `-->`, `--!>`, `<!--`, `<script>`, `&amp;`, newlines, emoji and U+2028. The encoded JSON contains no raw `<`, `>` or `&`.
- **Exact bytes:** `a --> b` encodes as `"a --\u003e b"` (§1 row 8).
- **Multiple blocks:** a review body with one `review` and two `finding` blocks gives `decodeAll` in order. For `pr` blocks, the first valid one wins and `DUPLICATE_BLOCK` is raised (02 §9.2).
- **Unknown version:** `ghx:v2` gives `invalid/unsupported-version`, which the caller maps to `SCHEMA_NEWER`.
- **Absence:** a plain body gives `absent`. `<!-- ci-duration-watch -->` and `<!-- other -->` are ignored.
- **Malformed:** truncated JSON gives `invalid/json`, and decoding never throws.
- **Whitespace:** CRLF bodies and extra spaces in the marker still decode.
- **upsert:** idempotent (twice equals once), replaces in place, and appends after the footer with one blank line.
- **Size:** a body plus block over 65 536 chars gives `META_TOO_LARGE`.
- **Real bodies** from `test/fixtures/bodies/` (§6.2).

**Body rendering, golden files** (`test/unit/render/pr-body.test.ts`). Each case is `test/fixtures/render/<case>.input.json` with a matching `<case>.body.md`:
- `worked-example-3301`: the exact body from 02 §14.2, byte for byte;
- `stacked-draft` (`· Stacked on #3184`);
- `closes-multiple`;
- `tests-mixed` (`2/3 pass, 1 not-run`);
- `details-mode`;
- `footer-null`;
- `unicode-title`.

Comment and review renderings live in `test/unit/render/comment.test.ts`: `review-body-3-findings`, `inline-finding-alsoat`, `resolve-reply`, `precondition-comment`, `supersede-comment` and `status-comment`.

**Policy engine** (`test/unit/policy/merge.test.ts`). One row per 02 §8.2 rule, each with a fail and a pass case. In addition:
- **Exit class:** all blockers state-class gives 9; any policy-class blocker gives 6.
- **`CI_NO_CHECKS`** passes automatically with `actions/workflows total_count: 0` or `ci.none`.
- **`CI_RED`** is waived only for `same-tests` or `same-step`. It blocks for `different`, `main-green` and `no-main-run`. `merge.sharedRed: off` always blocks.
- **Fail closed:** an unknown severity counts as high, and a precondition with status `unknown` blocks.
- **`KEY_STEP_SKIPPED`** fires on a skipped key step in a green job.
- **Warnings:** a base change under 24 h old, children, risk `high`.

Overrides (`overrides.test.ts`):
- an unknown code gives `VALIDATION`;
- a non-overridable code (`METHOD_NOT_ALLOWED`) gives `VALIDATION`;
- an unused override gives the warning `OVERRIDE_UNUSED`;
- a missing `--reason`, or one over 200 chars, gives `VALIDATION`.

**Log processing** (`test/unit/ci/logs/*.test.ts`):
- `strip.test.ts`:
  - SGR codes (`\x1b[36;1m`, `\x1b[0m`, `\x1b[2m…\x1b[22m`), OSC 8 hyperlinks and lone `\r` progress lines;
  - the BOM at byte 0;
  - the ISO timestamp prefix `2026-10-21T16:55:29.0214049Z `;
  - the `--log-failed` prefix `job\tUNKNOWN STEP\t<ts>\t` (§6), which appears in pasted logs;
  - a 2.3 MB log streams in bounded memory (heap growth stays under 3× the file size).
- `steps.test.ts`:
  - lines are attributed with `##[group]`/`##[endgroup]`, cross-checked against the jobs API step list, so the failing step is named and never `UNKNOWN STEP`;
  - the newer `##[end-action id=…;outcome=…]` lines seen in the corpus are tolerated;
  - a job with no groups is attributed to the failing step from the API.
- Extractors. One file per runner, each run on a real sandbox log fixture and on a minimal synthetic one:
  - **vitest:** `×`/`✗` lines, ` FAIL  file > suite > test`, `Test Files  1 failed`, `AssertionError: expected 3 to equal 4`.
  - **jest:** `●  suite › test`, `Tests: 1 failed`.
  - **node:test:** TAP `not ok 3 - name` and the spec reporter's `✖ name`.
  - **pytest:** `FAILED py/test_sandbox.py::test_x - AssertionError`, `=== 1 failed`.
  - **go test:** `--- FAIL: TestX (0.00s)`, `FAIL\tpkg`, and subtests like `TestX/sub`.
  - **generic:** `##[error]` (including `The operation was canceled.`), `ERR_PNPM_*`, and the exit line `Process completed with exit code 1.`
- Caps:
  - `FailingJob`: 30 tests, 20 errors, 300 chars per line; excerpt default 20 lines, cap 60, ≤2 000 chars.
  - Diagnosis events: ≤10 tests, ≤5 errors, ≤10 lines or 1 500 chars.
  - `CompactDiagnosis`: ≤5 tests.
- Deduplication: a test reported on both a summary line and a detail line is listed once.

**ETA, backoff and stall math:**
- `eta.test.ts`:
  - median and p90 with 1, 2 and 10 samples;
  - queued checks add the median queue time;
  - ETA is clipped at 0 when overrun;
  - ETA is the max over pending checks;
  - push-run job names that don't match fall back to `pull_request` runs;
  - the 24 h cache is hit on FakeClock.
- `interval.test.ts`:
  - `registering` polls every 10 s;
  - `running` polls at eta/6, clamped to 15–60 s;
  - 10 s within 60 s of an expected completion;
  - 30 s after the ETA is overrun;
  - `remaining` under 10% multiplies the interval by 4 and emits `rate-limit`;
  - an exhausted budget pauses until `resetAt`;
  - an unattended session never polls faster than every 30 s;
  - jitter stays within ±10% over 1 000 seeded draws.
- `stall.test.ts`: the cases listed under M4.5.
- `retry.test.ts` (01 commit 6): jitter bounds; `Retry-After` honoured; never past a deadline when one exists.
- `mergeable.test.ts`: sleeps of 1, 2, 3, 4, 5, 5 s, totalling ≤20 s (30 s for merge).

### 5.2 Must-have regression tests

Each one lives in `test/regression/<name>.test.ts`, carries a header comment citing its finding, and runs in default CI. Exit codes are as in revised 02 §6.1.

| ID | File | Guards (finding) | Setup → assertion |
|---|---|---|---|
| R01 | `merge-head-pinning.test.ts` | Only 8 of 52 merges pinned the head (§4.3); G-SHA | (a) `--expect-head` with a stale SHA gives `HEAD_MOVED`, exit 9, with `details.{expected,actual}`, and **no PUT** appears in the call log. (b) Race: the snapshot sees head `H`, and the PUT returns 409 `Head branch was modified`. The PUT body's `sha` equals `H`, the result is `HEAD_MOVED` with exit 9, and the 409 is **not retried**. (c) The hint names `ghx pr status <ref>` and the new SHA |
| R02 | `run-view-log-refused.test.ts` | `run view --log` refuses mid-run, 16 times (§0, §3.1) | The run is in progress, and the failing job is complete. `ci why` returns the log through `actions/jobs/{id}/logs`, with a test name in `tests[]`, and `expectNoCall(['run','view'])` passes. Variant, job still running (blob 404): `logPath:null`, warning `LOGS_NOT_READY`, exit 0. Variant, expired (410): warning `LOGS_UNAVAILABLE`, not `GH_FAILED`, and not retried |
| R03 | `mergeable-unknown.test.ts` | UNKNOWN before 20 of 52 merges (§5.2, §7 #3204) | `UNKNOWN`×3 then `MERGEABLE` gives `settled:true` after 4 queries and sleeps of 1+2+3 s on FakeClock. If it stays UNKNOWN: `pr status` gives `settled:false` and a warning after 20 s, and `pr merge` gives `MERGEABLE_UNKNOWN` with exit 9 after 30 s and no PUT. A head change mid-retry restarts the retry once, then reports |
| R04 | `no-checks-yet.test.ts` | "no checks reported" 11 times (§3.1, §5.2) | `ci wait`: zero checks until t=45 s, then pending, then pass. It never reaches a `no-checks` outcome, and exits 0. Zero checks through the default 120 s grace gives `no-checks`, exit 13, never 0 and never `stalled`. `pr status` with zero checks gives `ci.state: "no-checks"`, `phase: "registering"` and `merge.ready: false` |
| R05 | `hidden-conflict.test.ts` | The #3198 conflict was hidden by `\| tail -1` (§3.3) | A snapshot showing `CONFLICTING`/`DIRTY` gives `MERGE_BLOCKED` with the blocker `MERGE_CONFLICT`, exit 9, and a hint containing `git fetch origin main && git merge origin/main`. No PUT is sent. Race variant: the snapshot says `MERGEABLE`, the PUT returns 405, and the re-read says `DIRTY`, which gives `MERGE_CONFLICT`. In both, stdout is exactly one JSON line, so a `tail` can't hide it |
| R06 | `squash-refused.test.ts` | 4 unwanted squashes; "Do not squash" (§4.3, §7) | With default config, `--method squash` gives `METHOD_NOT_ALLOWED`, exit 6. `--override METHOD_NOT_ALLOWED` gives `VALIDATION` (exit 2), since the code isn't overridable. With config `allowedMethods: [merge, squash]`, `--method squash` sends a PUT with `merge_method: "squash"`. A repo with `squashMergeAllowed: false` refuses. With no `--method`, the PUT carries `merge_method: "merge"` |
| R07 | `others-pr-refused.test.ts` | `feedback_only_own_prs.md` (§4.3) | If the author isn't the viewer: `MERGE_BLOCKED` with `AUTHOR_NOT_VIEWER`, exit 6. `--override AUTHOR_NOT_VIEWER --reason "user asked in chat"` proceeds, and the override is recorded in `plan.overrides`. The override without `--reason` gives `VALIDATION`, exit 2. `ci retrigger` behaves the same |
| R08 | `shared-red-mergeable.test.ts` | "merge when main shares red", #3246 (§4.3, §7) | The PR's failing vitest test also fails on main's latest push run. `ci wait` gives `red-shared`, exit 11. `pr status` gives `merge.ready:true` with a `CI_RED` waiver. `pr merge` merges. Counter-cases: same job but a different test gives exit 10 with blocker `CI_RED`; main green gives exit 10; `merge.sharedRed: off` gives the blocker |
| R09 | `auto-retarget.test.ts` | #3194 and #3195 auto-retargeted; timeline digging (§4.1, §2.4) | A Q1 fixture with `AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT` gives `stack.baseChanges: [{from:"feat/mr-08c", to:"main", automatic:true}]`, a merge warning for a base change under 24 h old, and `declaredParent` ≠ `parent`. A manual `BASE_REF_CHANGED_EVENT` gives `automatic:false` |
| R10 | `cwd-repo-mismatch.test.ts` | sektar #3258 (§3.1, §4.1) | The fake git cwd remote is `powerhouse-inc/sektar`. `ghx pr status 3258` gets GraphQL `NOT_FOUND` → `PR_NOT_FOUND`, exit 5, `details:{repo:"…/sektar", repoSource:"cwd"}`, and a hint containing `powerhouse-inc/powerhouse#3258`. With the `o/r#3258` selector: success plus the warning `CWD_REPO_MISMATCH`. A `--repo` that disagrees with the selector gives `VALIDATION`, exit 2. A cwd outside any git repo gives `REPO_NOT_FOUND` (§3.1 "not a git repository") |
| R11 | `title-drift.test.ts` | The title changed on retry (§4.1) | Input title `fix(reactor): order by createdAt, id`, plus a description containing backticks, `$2`, `"` and `\`. The POST body's `title` and `body` are byte-identical to the input and the render. They travel as JSON on stdin (`--input -`), never in argv. A read-back with a different title gives `READBACK_MISMATCH`, exit 7, with `details.{sent,stored}` |
| R12 | `body-edit-preserves-block.test.ts` | 35 edits; bodies edited up to 4× (§4.2) | `pr edit` with `{"description": "…"}`: the PATCH body has exactly one block, `rev` goes from 1 to 2, the `id` is unchanged, the other fields are preserved, and the trailer is re-rendered. Visible text edited in the UI, plus a patch without `description`, gives `DESCRIPTION_DRIFT` (exit 9) and no PATCH; `--discard-ui-edits` proceeds. A PR without a block gives `NO_BLOCK`; `adopt:true` with every field works. If `updatedAt` changes before the PATCH: `CONCURRENT_EDIT` |
| R13 | `unstructured-and-bots.test.ts` | Brief 7; comment types (§8c) | A fixture PR with a human `MEMBER` comment (no block), a Copilot inline comment, a `github-actions[bot]` comment starting with `<!-- ci-duration-watch -->` (§8c4), and a ghx review. The human comment is in `comments[]` with `structured:false`. `bots[]` has 2 items: one with `marker: "ci-duration-watch"`, and the Copilot item keeping its path and line. Conservation holds: items in = items out |
| R14 | `untrusted-block-ignored.test.ts` | 02 §9.4 trust rule (prompt injection) | A `CONTRIBUTOR` comment carries a valid `resolve` block marking `f_h4x8pz` addressed, and a `NONE` comment carries a `precondition` override to `met`. Both come back `structured:false` with the warning `UNTRUSTED_BLOCK`. The finding stays `open`, and `pr merge` still reports `FINDINGS_OPEN`. A trusted resolve citing an unreachable commit gives `verified:false`, status `open`, and the warning `EVENT_COMMIT_UNREACHABLE`. A bot not listed in `trust.bots` is untrusted |
| R15 | `diff-300-files.test.ts` | HTTP 406 beyond 300 files, twice (§3.1, §9.10) | `ghx pr diff 3169` (passthrough) gets the verbatim 406 stderr and returns `DIFF_TOO_LARGE` (exit 7) with a local `git diff` hint. `pr create` where the compare returns 300 files: when the cwd matches, local `git diff --name-only` (fake git) is used; otherwise the warning `COMPONENTS_UNCHECKED`. `pr review` paginates `pulls/N/files` past 300 entries, and files without `patch` become body-only, with the warning `FINDING_NOT_INLINE` |

More regressions, also in default CI:
- **R16** `merge-transient-recovered.test.ts` (#3214): a GraphQL "Something went wrong" or a 502 on the PUT, then a re-read showing the PR merged at `H`, gives success with `recoveredFromTransient: true` and exactly one PUT.
- **R17** `already-merged.test.ts` (#3211): gives `alreadyMerged: true`, exit 0.
- **R18** `rerun-already-running.test.ts`: covers `cannot be rerun; This workflow is already running` and `job … cannot be rerun`.
- **R19** `key-step-skipped.test.ts`: §6's misleading green.
- **R20** `ci-wait-never-reruns.test.ts`: a flaky candidate appears in `rerunCandidates`, `next` contains `ghx ci rerun <ref> --flaky`, and `expectNoMutations()` passes (brief decision).
- **R21** `resume-after-kill.test.ts`. Guards against background waits being killed: by a subagent ending, by the documented 30-minute `-p` cap, or by Monitor's 30-minute expiry, which made agents re-arm 44 hand-written scripts (§5.2; 02 §11.0). Run 1 is aborted mid-wait; the identical re-run makes no repeated baseline or diagnosis calls, and a re-run after a terminal state makes one conditional head check and returns the stored outcome.

---

## 6. Fixtures

### 6.1 Recording mode

- **Record.** `src/proc/recording.ts` decorates the real `ProcessRunner`. When `GHX_RECORD_DIR=<dir>` is set, every `gh` call ghx makes is written as `<dir>/<NNN>-<slug>.json` in the `GhFixture` shape (§4.2).
  - `meta.source` comes from `GHX_RECORD_SOURCE`, and `ghVersion` from `gh --version`.
  - Log bodies streamed through `stdoutFile` are copied next to the fixture as `<NNN>-<slug>.log`.
  - Any command can be recorded, for example `GHX_RECORD_DIR=test/fixtures/gh/pr-status/clean GHX_RECORD_SOURCE=live:sandbox ghx pr status <sandbox>#12`.
- **Scenarios.** `pnpm fixtures:record <scenario>` runs `scripts/fixtures/scenarios/<scenario>.ts`. Each script:
  1. puts the sandbox into a state (a branch, a `ci/mode.json` commit, a PR);
  2. waits for it;
  3. runs ghx commands, or raw read-only gh calls for shapes ghx never requests itself;
  4. writes the fixtures;
  5. cleans up.

  Scenario setup mutates the sandbox, so these scripts run only against `$GHX_SANDBOX_REPO`, behind the same guard as the live tests (§4.4).
- **Redact.** `pnpm fixtures:redact <dir>` (`scripts/fixtures/redact.ts`):
  - scrubs tokens (`gh[opsu]_\w+`, `Bearer …`), emails, `X-Github-Request-Id`, the blob `RequestId:` and SAS query strings;
  - normalises `Date` headers;
  - maps logins to stable aliases (`viewer-user`, `other-user`, `maria-dev`);
  - keeps SHAs and timestamps, which the ETA, stall and ordering tests need.
- **Corpus.** Fixtures never come from the private transcript corpus. Where a shape was only seen there, a synthetic fixture reproduces it with sandbox names (`meta.source: "corpus-shape"`).
- **Drift check.** `pnpm fixtures:verify` (live workflow only) re-records every `live:*` scenario into a temp directory and compares **shapes**: key sets, JSON types, status lines, and stderr with numbers masked. A mismatch fails with a diff, so a gh or GitHub API change shows up before users hit it.

### 6.2 Inventory

The corpus provided the list; the sandbox and public repos provide the bytes. The last column names the scenario script that re-captures each fixture.

| Fixture path (under `test/fixtures/`) | Content | Source | Re-capture |
|---|---|---|---|
| `gh/ci-snapshot/{pending,fail,pass,no-checks,rerun-duplicates,status-context,ignored-noise,oid-mismatch}/` | The CI subset of Q1, with rollups in each state; duplicate attempts; a commit StatusContext; a skipped `notify-noise` | live:sandbox | `ci-states` (pushes mode commits; captures at registering, running and settled) |
| `gh/pr-snapshot/merge-{clean,unknown,conflicting-dirty,behind,blocked,unstable,draft,merged}/` | Q1 PR fields, covering the same facts agents read with `pr view --json mergeable,mergeStateStatus,…` (§2.2). UNKNOWN is captured right after a push | live:sandbox | `merge-states` (UNKNOWN: query within 1 s of pushing to the base; DIRTY: two branches editing the same line; BEHIND: a second branch whose ruleset requires being up to date) |
| `gh/rest-checks/{check-runs-200,check-runs-304,status-200,status-304,pulls-200-etag}.json` | A conditional REST tick, with headers | live:public (cli/cli) and live:sandbox | `etag` (re-runs spike §3.1 against the sandbox head) |
| `gh/jobs/{queued-no-runner,in-progress,completed}.json` | Jobs-API rows for stall detection (spike §3.5: `runner_id: null`, `started_at == created_at` while queued) | live:public and live:sandbox (`stuck.yml`) | `stall` |
| `gh/contents/workflow-{literal-timeout,expr-timeout,no-timeout,matrix}.json` | Workflow files fetched through the contents API, for `job-timeouts.ts` | live:sandbox | `stall` |
| `gh/logs/{vitest,jest,node-test,pytest,go}-fail.log` plus `.json` | Raw job logs with BOM, timestamps, ANSI and `##[group]`/`##[error]` | live:sandbox (the `fail.yml` matrix); `go` also from cli/cli job 119137909038 | `logs-matrix` |
| `gh/logs/{cancelled,pnpm-err,infra-econnreset}.log` | `##[error]The operation was canceled.` with `##[end-action …]`; `ERR_PNPM_*`; `ECONNRESET` | corpus-shape (synthetic, matching §5.1 and the line format seen in the corpus) | maintained by hand; `fixtures:verify` skips `corpus-shape` |
| `gh/logs-api/{ok-200-azure,blob-404-in-progress,blob-404-skipped,gone-410}.json` | The four spike §3.3 responses, verbatim | live:public | `spike-logs` (runs the `scripts/spike-gh.ts` probes 3a–3d) |
| `gh-stderr/run-view-in-progress.txt` | `run 37948190914 is still in progress; logs will be available when it is complete` | corpus-shape (verbatim from §3.1) | `ci-why` captures the real string by running `gh run view --log` (read-only) on a sandbox run in progress |
| `gh-stderr/{no-checks,not-a-git-repo,could-not-resolve-pr,already-merged,graphql-something-went-wrong,rerun-already-running,job-cannot-be-rerun,unknown-json-field}.txt` | Verbatim §3.1 strings, for the classifier tests | corpus-shape | gh's message text is stable. `fixtures:verify` re-produces `no-checks`, `could-not-resolve-pr` and `not-a-git-repo` with read-only calls |
| `gh/diff-406/{pr-diff-stderr.txt,pulls-files-page-{1..4}.json}` | `could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). …`, and a paginated files list with `patch` omitted for large files | live:sandbox (a branch with 320 generated files) | `diff-300` |
| `gh/merge/{put-200,put-405-not-mergeable,put-409-head-modified,put-405-squash-disabled}.json` | REST merge responses. **The raw conflict error was never observed in full** (only the `tail -1` hint line survived, §3.3), so it is recorded fresh | live:sandbox | `merge-outcomes` (405 via a DIRTY branch; 409 via the barrier race in §4.4.3; squash-disabled needs a repo setting toggled, Q2) |
| `gh/merge/graphql-transient.json` | `GraphQL: Something went wrong while executing your query …` | corpus-shape | maintained by hand |
| `gh/feedback/{issue-comments,reviews,review-threads,pulls-comments}.json` | All three sources: a human comment, a Copilot inline comment (§8c3), a `github-actions[bot]` `<!-- ci-duration-watch -->` comment, and a ghx review with findings | live:sandbox (the bot-comment workflow). The Copilot shape is synthetic unless Copilot review is enabled on the sandbox | `feedback` |
| `gh/feedback/untrusted-{resolve,precondition}.json` | Comments with `authorAssociation: CONTRIBUTOR` or `NONE` carrying valid blocks | synthetic, or live:sandbox with a second account (Q2) | `feedback-untrusted` |
| `bodies/{structured-v1,structured-v2-future,malformed-block,no-block-human,two-pr-blocks,crlf}.md` | Bodies for the codec and fold tests | synthetic, plus live:sandbox for `structured-v1` | `pr-create` |
| `gh/timeline/{automatic-base-change,manual-base-change}.json` | Q1 `timelineItems` with `AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT` | live:sandbox (a stack of 2; merge the parent with branch deletion) | `retarget` |
| `gh/rules/{rules-copilot-only,rules-deletion-dup,rules-required-checks,branch-protected-contexts,protection-404}.json` | The spike §3.2 shapes. `rules-required-checks` comes from the sandbox ruleset | live:public and live:sandbox | `rules` |
| `gh/graphql/{partial-not-found,rate-limit-headers-dup}.json` | Spike §3.4 | live:public | `spike-graphql` |
| `gh/rerun/{post-201,run-in-progress,attempt-3,flaky-attempts}.json` | Rerun preflight, attempt history and POST | live:sandbox (`flaky.yml`) | `rerun` |
| `gh/create/{preflight,compare-300,post-201,post-422-exists,readback}.json` | The create flow | live:sandbox | `pr-create` |
| `gh/review/{files-hunks,post-200,post-422-line,post-422-self-approve,review-comments}.json` | The review flow, including GitHub's self-approval 422 text | live:sandbox | `pr-review` |
| `gh/doctor-*` | 01 commit 14 | synthetic and live | `doctor` |
| `golden/pr-status-3301.json`, `render/*` | Worked-example goldens (02 §14) | synthetic, from 02 | `UPDATE_GOLDEN=1`, locally |
| `hook/{bash-ci-wait-foreground,bash-ci-wait-background,bash-ci-wait-envprefix,bash-cd-and-ci-wait,monitor-gh-checks-loop,monitor-run-watch,monitor-unrelated,bash-until-gh-run-list}.json` | PreToolUse event payloads: Bash `{command, description, run_in_background?}` and Monitor `{command, description, timeout_ms}` | live: logged by the spike-hook throwaway hook (§3.6), then varied by hand | `scripts/spike-hook.ts --record` |
| `wait-state/{v1-midwait,v1-terminal-red,corrupt,expired}.json` | `ci wait` state files for the resume tests | synthetic, written by `state.ts` under FakeClock | regenerated by `test/commands/ci-wait-resume.test.ts` with `UPDATE_GOLDEN=1` |
| `golden/ci-wait-summary-3301.json` | The 02 §14.4 summary as stdout, following the §11.9 schema (no `advice`) | synthetic, from 02 | `UPDATE_GOLDEN=1`, locally |

---

## 7. CI for ghx itself

### 7.1 `.github/workflows/ci.yml` (default CI)

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest] }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    env: { GHX_ARTIFACT_DIR: "${{ runner.temp }}/ghx" }
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: pnpm/action-setup@<pinned-sha>        # version from packageManager
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - name: Unit, command, regression tests
        run: node --test --test-reporter=dot "test/{unit,commands,regression}/**/*.test.ts" "test/*.test.ts"
      - name: Contract tests (spawn bin with fake gh)
        run: node --test --test-reporter=dot "test/contract/**/*.contract.test.ts"
      - name: Coverage gate
        if: matrix.os == 'ubuntu-latest'
        run: pnpm test:coverage
      - run: pnpm docs:check                         # skill/command index not stale
```

- **macOS is required.** Pipe flushing is asynchronous there (01 §3.5), and there is no `timeout` binary (§0).
- **No step needs gh auth.** The contract tests put the fake `gh` first on PATH. `env.contract.test.ts` fails if the real gh is ever reached: each fake reply carries a sentinel, and a real gh response would lack it.

### 7.2 `.github/workflows/live.yml` (opt-in)

The workflow triggers on `workflow_dispatch` only, and runs in a GitHub environment named `sandbox` with the user as required reviewer. Steps:
1. `node scripts/spike-gh.ts`, which fails if any §3 assumption has changed;
2. `pnpm test:live`;
3. `pnpm fixtures:verify`.

It uses `GHX_SANDBOX_TOKEN` and `GHX_SANDBOX_REPO`, runs on ubuntu only, and is never triggered by a push.

### 7.3 Dogfooding

**Config.** `.github/ghx.json` in this repo (01 commit 15, moved to M12.1) has:
- components `cli`, `core`, `gh`, `ci`, `pr`, `policy`, `meta`, `config`, `render`, `docs`, `test` and `build`, each with `paths`;
- `merge.method: merge`;
- `ci.expected: [{name: "check (ubuntu-latest)"}, {name: "check (macos-latest)"}]`.

`test/dogfood-config.test.ts` loads it with `loadConfig` and renders a sample PR through it.

**Use.** The user lands on `main` without PRs, so dogfooding on this repo is branch-based:
- after each push: `ghx ci wait branch:main@$(git rev-parse HEAD)`, run in the background;
- on red: `ghx ci why --run <id>`.

The PR commands are dogfooded on the sandbox, by the live suite and by the acceptance run (§8.2). From M8 on, any PR opened on this repo goes through `ghx pr create` and `ghx pr merge`.

---

## 8. Definition of done for v1

### 8.1 Checklist

1. **Commands.** Every v1 command exists and is registered in `src/commands/index.ts`: `ci why`, `ci wait`, `ci rerun` (with `--flaky`), `ci retrigger`, `pr status`, `pr feedback`, `pr create` (with `--batch`), `pr edit`, `pr merge`, `pr comment`, `pr review` and `pr resolve`, plus `doctor`, `init`, `version`, `schema` and passthrough.
2. **CI.** `pnpm check` and the contract tests are green on ubuntu and macOS in `ci.yml`. Coverage is at least 90% of lines in `src/{ci,policy,meta,feedback,pr/create,render}`.
3. **Regressions.** R01–R21 exist under `test/regression/` and pass.
4. **Exit codes and errors.** `exit-codes.contract.test.ts` covers the 02 §6.1 table row by row. Every 02 §6.2 code, plus the §1 additions, is produced by at least one test: `test/error-coverage.test.ts` greps the test tree for every registered code.
5. **Read-only and dry-run.** `registry.test.ts` passes for every spec: no read command issues a mutating call, and every write command halts in `--dry-run` before mutating. `ci wait` is `kind:'read'`.
6. **The `ci wait` protocol holds.**
   - By default stdout is one `WaitSummary` (or one error document), never spilled, and under 16 KB with 10 targets. `--stream` keeps the NDJSON invariants.
   - It ends only on CI-derived outcomes (green, red, red-shared, superseded, closed, no-checks, stalled), on `pending` when unattended at 25 min, or on a signal (`interrupted`).
   - The stall, resume and unattended tests (M4.5–M4.7) pass on FakeClock, and the contract tests pass with no deadline set (§4.3).
7. **Live run.** One manual run of `live.yml` passes, including the moved-head race and both stall cases, and `fixtures:verify` reports no drift.
8. **Discovery.** `ghx --help`, `<cmd> --help` and `<cmd> --schema` describe every command, and `docs/agents/*` is generated and not stale.
9. **Steering.** The steering kit is documented and works.
   - With the `permissions.deny` rules and the hook in ask mode, a raw `gh pr merge` is blocked, and `gh pr checks` (including inside a Monitor loop) gets a `ghx ci wait` suggestion.
   - A foreground `ghx ci wait` is rewritten to `run_in_background: true`.
   - Checked by `test/commands/hook.test.ts` plus `scripts/spike-hook.ts` against the installed Claude Code.
10. **Acceptance.** The agent acceptance run (§8.2) passes three times in a row.

### 8.2 Agent acceptance

**The scripted run**, `scripts/acceptance/run.ts`, needs a sandbox and `claude` on PATH. It has three steps.

1. **Setup.** This step is scripted; the agent doesn't do it.
   - Create branch `accept/<id>` from `main`, with a real bug in `app/vitest/sum.ts` that makes the vitest job fail. `ci/mode.json` stays `none`, so the failure is genuine.
   - Open a PR with `ghx pr create`. `main` is green.
2. **Agent session.** Run `claude -p "$(cat scripts/acceptance/prompt.md)" --output-format stream-json --verbose --settings scripts/acceptance/settings.json`, with cwd set to a fresh clone of the branch.
   - The prompt is: "PR <ref> is failing CI. Find out why, fix it, get CI green and merge it. Follow CLAUDE.md."
   - The clone's `CLAUDE.md` is `docs/agents/claude-md-snippet.md`, which says to run `ci wait` in the background.
   - `settings.json` carries the `permissions.deny` rules for raw gh writes, plus the hook (matcher `Bash|Monitor`) with `run_in_background` rewriting on and `deny` mode for wrapped reads.
   - The sandbox CI finishes well under 25 min, so the unattended `pending` return isn't expected. If it happens, the scorer counts the identical re-run as part of the same wait.
3. **Scoring.** `scripts/acceptance/score.ts` parses the stream-json events and the resulting GitHub state.
   - **Per CI wait:**
     - a `tool_use` whose command starts with `ghx ci wait`;
     - its `tool_result` saying `Command running in background` (per §3.6 this, not the `tool_use` input, shows the rewrite took effect);
     - exactly one `task_notification` for that task id.
   - A wait fails if it has any `Monitor` call, any `Read` of the task's `.output` file, any `sleep`, or any second `ghx ci wait` on the same SHA before the notification.

| Metric | Pass threshold | Baseline (§5.1, §5.3, §8b) |
|---|---|---|
| **Waiting on CI** | **Exactly 1 tool call and 1 wake per wait** (the default `first-failure` wait, and the post-fix `--until mergeable` wait) | median 3 `pr checks` polls per PR (max 22), 44 Monitor scripts, 232 sleep loops (§5.2) |
| GitHub-touching calls to diagnose (from the first call to the first source edit) | ≤1: the `ci wait` summary carries the diagnosis, or one `ci why` | median 6 |
| Calls for the full PR state before merging | 1: `pr status`, or the `ci wait --until mergeable` summary | 5–8 |
| GitHub-touching calls, end to end | ≤5, e.g. `ci wait`, `git push`, `ci wait --until mergeable`, `pr merge --dry-run`, `pr merge` | about 14 (6 to diagnose, a median of 3 polls, 5 merge steps) |
| Raw `gh` invocations | 0 | — |
| Commands with `\|`, `sleep`, `timeout`, `--jq` or `perl -e 'alarm` around ghx | 0 | 66% piped (§0) |
| Harness refusals (deny rules, hook, guard) | 0 | 19 + 9 + 6 (§3.2) |
| Outcome | Merged with a merge commit (not squash), `merged_at` set, the merge pinned to the head evaluated, and the `main` CI wait either started or reported in `next` | — |

**The manual fallback checklist**, for when `claude -p` isn't available. A human runs the same prompt in an interactive session and checks that:
1. The first GitHub call is a ghx CI command.
2. The diagnosis names the failing test and file without a second log fetch.
3. Each CI wait is one background `ghx ci wait` call with one wake. There is no Monitor, no loop, and no reading of the task output file.
4. `pr merge` is called with `--expect-head`, or reports the pinned SHA.
5. No raw gh, pipes or sleeps appear.
6. The PR is merged with a merge commit.

---

## 9. Risks and open questions

### Open questions for the user

- **Q1. Termination when an expected check never registers.** 02 §11.3 still says a missing required or config check waits "until the budget runs out", but there is no budget now. The stall rules only cover queued and running checks, so an attended wait could stay open forever on a required check whose workflow never triggers. Proposal (§1 row 4): `stalled` with `{state:"missing"}` once everything else has settled plus `ci.stall.queuedMinutes`. This needs `"missing"` added to the `stalled[].state` enum.
- **Q2. Sandbox ownership.**
  - Who creates `<owner>/ghx-sandbox`?
  - Is it public (free Actions minutes; needed for a realistic `CONTRIBUTOR` author) or private?
  - Is a second GitHub account available for the untrusted-author and someone-else's-PR live cases? Without one, R07 and R14 stay fixture-only (still in default CI), and `put-405-squash-disabled` needs a second sandbox repo.
- **Q3. Test seams in production code.** Two env-gated seams, both inert unless `GHX_TEST_HOOKS=1`:
  - the merge barrier (§4.4.3), the only way to prove server-side head pinning live;
  - `GHX_TEST_CLOCK_OFFSET_MS`, so the contract test for exit 15 doesn't wait 25 real minutes.

  Without them, R01 stays fixture-backed, and exit 15 is covered only by the in-process FakeClock test.
- **Q4. The log-redirect fallback.** If gh ever stops following the logs redirect, is a direct `fetch()` of the pre-signed URL acceptable? It would be the only network call outside gh.
- **Q5. Codes 02 leaves open.** Confirm:
  - `DIFF_TOO_LARGE` is exit 7 (02 §10 names no exit);
  - `READBACK_MISMATCH` (7) is new;
  - the new warnings `LOGS_NOT_READY`, `LOGS_UNAVAILABLE`, `REQUIRED_CHECKS_UNKNOWN` and `WAIT_STATE_DISCARDED`;
  - passthrough's inline text cap drops from 02's 32 KB to fit the 16 KB global bound.
- **Q6. Where `timeout-minutes` comes from.** No API exposes it (§3.5), and 02 §11.1 uses it for first-run stalls. The options: a line scan of the workflow YAML (no dependency, but expressions and matrix name mapping fall back to 360), or a YAML parser dependency (a second runtime dep beside zod). Since GitHub itself cancels at the same limit, the line scan is probably enough.

### Risks

- **Hook behaviour is version-dependent.** §3.6 holds on Claude Code 2.1.280. The subagent-wake behaviour 02 §11.0 relies on contradicts the docs. Mitigations: `scripts/spike-hook.ts` after upgrades; resumability, so a lost wake costs one re-run; and the deny-with-exact-call fallback, kept in `src/hook/rules.ts` behind a flag.
- **Environment leakage in tests.** Agent sessions set `CLAUDE_CODE_SESSION_ATTENDED=1` (observed). A test that inherits `process.env` passes in an agent session and fails in CI. Mitigation: the harness builds env from scratch, plus an architecture grep (M4.7).
- **Required checks via rulesets** weren't seen in any sampled repo (§3.2). The parsing is built from the docs and proven only against the sandbox ruleset.
- **Log fetches carry no rate headers** (§3.3), so their cost is invisible to `RateBudget`. The diagnosis cap of 5 jobs and the per-job-id test cache bound it.
- **GitHub log format drift.** The newer `##[end-action …]` lines show the runner log format still changes. The guards are `fixtures:verify` and the per-runner extractors. A failed extraction degrades to `errors[]` and an excerpt, never to an empty diagnosis.
- **Stall false positives.** The running rule depends on base-branch baselines. A PR that legitimately adds a lot of test time could trip `max(3×p90, p90+15m)`. The summary reports `forSec`, `thresholdSec` and `basis`, so the agent can see why and re-wait.
- **Unobserved live precondition.** `stuck.yml` relies on a job with unmatched self-hosted labels staying `queued` rather than failing fast. GitHub documents that behaviour, but it hasn't been observed here yet; the first `live.yml` run proves it.
- **Live-suite cost and flakiness.** Real Actions queue times vary. The live tests are opt-in and never gate merges, and the 20-minute running-stall case sits in a separate slow tier.

### Coordinator decisions on Q1, Q3–Q6 (2026-10-22)

These are implementation calls, so they were settled without the user. Q2 needs the user's resources and is asked separately.

- **Q1 (accepted, with a separate knob).**
  - A required or config-expected check that never registers ends the wait as `stalled` with `state:"missing"`. This happens once everything else has settled and `ci.stall.missingMinutes` (default **10**) has passed.
  - A workflow that never triggers is a misconfiguration, not slow CI, so it gets a shorter fuse than the 30-minute queue rule.
  - Add `"missing"` to the `stalled[].state` enum in 02 §11.9.
- **Q3 (accepted).** Both seams are inert unless `GHX_TEST_HOOKS=1`. `ghx doctor` warns if `GHX_TEST_HOOKS` or `GHX_TEST_*` is set outside the test runner.
- **Q4 (accepted, narrowly).**
  - ghx may fetch the pre-signed log URL directly, but only when gh stops following the redirect.
  - The URL must come from GitHub's own `Location` header, and its host must be on an allowlist of GitHub's log storage hosts.
  - It is a plain GET, never sends credentials, and is detected and logged as a warning.
- **Q5 (confirmed as proposed):**
  - `DIFF_TOO_LARGE` is exit 7.
  - `READBACK_MISMATCH` is exit 7.
  - The new warnings `LOGS_NOT_READY`, `LOGS_UNAVAILABLE`, `REQUIRED_CHECKS_UNKNOWN` and `WAIT_STATE_DISCARDED` are accepted.
  - Passthrough inline text is capped to fit the 16 KB global bound.
  - The expired-log 410 must map to `LOGS_UNAVAILABLE` and must never be classified as transient (§3.3).
- **Q6 (line scan).**
  - `timeout-minutes` comes from a line scan of the workflow YAML. If the scan can't resolve it, the value falls back to 360.
  - GitHub cancels at the same limit, so precision here only moves an early exit.
  - This keeps zod as the only runtime dependency.
- **Q2 (user, 2026-10-22).** The live suite is **deferred**. No sandbox repo is created for now, and there is no second GitHub account.
  - Every live case stays fixture-backed: the moved-head merge race, the stall cases, and the untrusted-author and someone-else's-PR cases.
  - Fixtures are recorded from public repos through the recording mode.
  - `live.yml`, the sandbox workflows and the Q3 merge barrier move to a post-v1 milestone.
  - The v1 definition of done drops its live-suite items. The agent acceptance check runs against fixtures and the CLI contract harness.
