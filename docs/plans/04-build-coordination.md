# 04: Build coordination

This file explains how the v1 build is split across subagents. Read it together with `00-brief.md` (read to the end; the decision sections override the body), `01-scaffolding.md`, `02-api.md` and `03-implementation.md`. 03's appended decisions override 03's body.

## Rules for every implementer

1. **Work on `main` in the shared working tree.** Don't create branches or worktrees, and never push. Commit freely in small logical commits, one per 03 commit-list item, using that item's message. End each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
2. **Stay inside your owned paths** (see the wave table). **Commit with an explicit pathspec in one command:** `git add <your paths> && git commit -m '…' -- <your paths>`. The index is shared, so a bare `git commit` sweeps in other agents' staged files. That happened once, in `042796e`. Never use `git add -A` or `git add .`. If `git commit` hits `index.lock`, wait a few seconds and retry. Never run `git stash`, `reset`, `checkout -- <file>`, `rebase` or `clean`, because other agents' uncommitted work is in the same tree.
3. **Shared files.** If you must touch a file outside your paths, keep the edit minimal and additive (for example, appending one registration line), re-read the file immediately before editing, and commit it right away together with the code that needs it. Do not reformat or lint-fix files you don't own. Scope biome and other tools to your own paths.
4. **Verify before every commit.** Typecheck must pass (`pnpm typecheck`, which covers the whole tree; if it fails only in another agent's files, note that and continue). Your own tests must pass. Each commit must also stand on its own.
5. **Exit codes and error names** come from `test/contract/exit-table.ts` and `src/core/errors.ts`. Don't retype them.
6. **If 02 and 03 disagree, or a plan is wrong or impossible, stop and report.** Don't invent behaviour. A small, obviously right local fix is fine; describe it in your report.
7. **Never touch the user's settings.** That means `~/.claude/**` and any real Claude Code settings. Spikes use scratch files under a temp directory.
8. **gh calls during development are read-only**, against public repos. Run no mutating gh or git-remote command.

## Verified harness facts (don't re-research them, and don't re-add timeouts)

These were checked on 2026-10-22 against Claude Code 2.1.280 (02 §11.0, 03 §3.6):

- An idle interactive agent is re-invoked when its background Bash command exits.
- An idle subagent is also re-invoked.
- A foreground Bash call that runs past its timeout is moved to the background, not killed.
- Background runs longer than 45 minutes complete.
- A PreToolUse `updatedInput` can set `run_in_background` without a permission decision.
- A non-zero exit shows as "failed" in the notification. Agents read the JSON summary instead of that label.
- **Unverified:** the 30-minute background cap in `claude -p` and the SDK comes from the docs only. `pending` (exit 15) and resume exist as the backstop for it.

## Waves

Waves run strictly in order. Agents within a wave run in parallel and own disjoint paths. A review agent checks each wave before the next one starts.

| Wave | Agent | Milestones (03) | Owned paths (indicative; exact paths per 01/03) |
|---|---|---|---|
| 1 | bootstrap | M0.1, M0.3, M1.1–M1.16 | everything it creates |
| 2a | schemas | M2.1 | `src/schemas/**` and its tests |
| 2b | ci-core | M2.2–M2.6 | `src/ci/` snapshot, logs, extract, compare-main and flake modules, plus their tests and fixtures |
| 2b | meta-feedback | M6.1, M6.2 | `src/meta/` payload schemas, `src/feedback/**` |
| 2b | create-core | M9.1, M9.2 | `src/pr/create/` schema, `src/render/**` |
| 3 | ci-why | M3.1, M3.2 | the `ci why` command and its tests |
| 3 | wait-pure | M4.1, M4.2, M4.5 | the expected-set, ETA/interval and stall modules |
| 3 | pr-core | M6.3, M6.4 | the PR snapshot, `src/policy/**` |
| 3 | pr-create | M9.3, M9.4 | the `pr create` command and `--batch` |
| 4 | ci-wait | M4.3, M4.4, M4.6–M4.9 | the poller, state machine, state store and `ci wait` command |
| 4 | pr-status | M6.5, M6.7 | the `pr status` and `pr feedback` commands |
| 4 | pr-edit | M10.1 | the `pr edit` command |
| 4 | feedback-writes | M11.1–M11.3 | the `pr comment`, `pr review` and `pr resolve` commands |
| 5 | ci-rerun | M5.1, M5.2 | `ci rerun`, `ci retrigger` |
| 5 | pr-merge | M8.1–M8.3 | `pr merge` |
| 5 | passthrough | M7.1 | the passthrough and refusals |
| 5 | wait-mergeable | M6.6 | `ci wait --until mergeable` |
| 6 | steering | M12.1–M12.4 | `docs/agents/**`, the hook command, `scripts/acceptance/**` |

Live tests and the sandbox (M0.2, `test/live/**`, `live.yml`) are deferred (03 Q2).

## Extension points

The bootstrap agent fills this in. For each kind of extension, it records the file or directory where you add it, and whether doing so needs an edit to a shared file. The aim is that adding a command, an error code or a fixture scenario needs no edit to a central shared file, or at most a one-line append.

Filled in by the wave 1 bootstrap agent (commits `f29f2eb`..`3cd7603`).

- **Commands: no shared edit.** One new file per command: `src/commands/<group>/<verb>.ts`, or `src/commands/<name>.ts` for a top-level command. Its default export is `defineCommand({...})` or `defineStreamCommand({...})` from `src/core/command.ts`, and its `name` must equal its path segments: `src/commands/pr/status.ts` is `name: ['pr', 'status']`.
  - The registry (`src/cli/registry.ts`) discovers commands from the directory, with no build and no index file. It resolves the longest positional prefix by statting candidate paths, then imports only that one module.
  - Path rules:
    - Segments match `[a-z][a-z0-9-]*`, with at most 3 levels.
    - Files and directories whose names start with `_` are helpers, never commands (for example `src/commands/pr/_shared.ts`). Put substantial logic in domain dirs (`src/ci/`, `src/pr/`, `src/policy/`, …).
    - A `<x>.ts` file and an `<x>/` directory must not coexist.
  - `test/registry.test.ts` proves the registry is complete and checks every spec automatically:
    - the summary is at most 100 chars;
    - every schema converts to JSON Schema, so no transforms are allowed;
    - no derived flag collides with a global flag;
    - every positional names a real field;
    - stream event types avoid `summary|error|heartbeat|warning`;
    - an `examples[0]` smoke run never exits 1, never mutates for reads, and halts under `--dry-run` for writes.
  - Every command needs at least one example. Give it `input` if the command takes JSON. By default the smoke run answers every gh and git call with a 404; ship `test/fixtures/gh/smoke/<name-with-dashes>/` to give it a real scenario.
  - Spec fields beyond 01 §3.1:
    - `jsonInput: 'required'` raises `USAGE_INPUT_MISSING` when `--input` is absent.
    - `timeout: null` means no deadline, and `--timeout` is refused.
    - Stream specs use `summarySchema` for the summary schema (01's sketch reused the name `summary`). They take `outputMode: 'final' | 'ndjson' | (input) => …`, and their context has `ctx.events.path()` and `ctx.events.setPath(p)`.
- **Error codes: one-line append** to the right exit-class section of `ERROR_CODES` in `src/core/errors.ts`.
  - The catalogue is already complete for the plans: all of 02 §6.2, 03 §1's additions (`READBACK_MISMATCH`, `DIFF_TOO_LARGE`, `PASSTHROUGH_WRITE_REFUSED`, `METHOD_NOT_ALLOWED`, `MERGEABLE_UNKNOWN`, `META_TOO_LARGE`), and 01's codes (`USAGE_*`, `CONFIG_*`, `ENV_*`, `INTERNAL_*`, `INTERRUPTED`, `TIMEOUT`, `REPO_AMBIGUOUS`, `GH_OUTPUT_UNEXPECTED`). Most milestones need no edit.
  - `MERGE_BLOCKED` exits 9 when `details.exitClass === 'state'` and 6 otherwise.
  - Internal gh failure codes (`GH_TRANSIENT`, `GH_LOGS_GONE`, …) stay internal. Catch `GhFailure` and read `.failure.code`. `publicCodeFor()` maps them; pass `notFound: 'PR_NOT_FOUND'` (etc.) on the call.
  - Tests read exit numbers from `EXIT` in `test/contract/exit-table.ts`. `test/unit/core/exit.test.ts` checks it against `src/core/exit.ts`.
  - Warning codes are free strings passed to `ctx.warn({code, message})`; there is no registry.
- **Fixture scenarios: no shared edit.**
  - gh fixtures go in a directory `test/fixtures/gh/<scenario>/` of `NNN-<slug>.json` files in the GhFixture shape (`test/helpers/fixture-match.ts`; `src/proc/recording.ts` writes exactly this shape). Nested groups such as `ci-snapshot/pending` work too.
    - File order is the reply order for the same canonical argv, and the last reply repeats.
    - In-process, use `FakeGh.fromScenario('<scenario>')` from `test/helpers/fake-gh.ts`, together with `runInProcess(argv, {gh})`.
    - For the spawned bin, set `GHX_FAKE_SCENARIO=<scenario>` with `spawnGhx(…, {fakeGh: true})`.
  - Re-capture scripts are one file each, `scripts/fixtures/scenarios/<name>.ts`, default-exporting `defineScenario` from `scripts/fixtures/scenario-api.ts`. Run them with `pnpm fixtures:record <name>`. Recording refuses mutating gh calls until the sandbox exists.
  - Non-gh fixtures (bodies, config, stderr) are files plus a `meta.source` entry in their directory's `_meta.json`.
  - `test/fixtures.test.ts` requires three things of every fixture: a `meta.source`, no token or email, and a reference from at least one test.
  - Biome ignores `test/fixtures/**`, so fixtures stay byte-exact.
- **Config keys: no shared edit within a section.**
  - Sections live in `src/config/sections/<section>.ts`. All eight from 02 §15 already exist: `components`, `title`, `render`, `create`, `merge`, `ci`, `trust`, `bots`.
  - Add a key by editing only that section's file, which its milestone owns: CI keys in `ci.ts`, create keys in `title.ts`/`render.ts`/`create.ts`, and so on.
  - A new top-level section is a new file plus one line in `src/config/schema.ts`.
  - Use `.prefault()`, not `.default()`.
  - Commands read config through `ctx.config()` after declaring `needs.config`.
- **Other hooks:**
  - Schema targets are one entry in `SCHEMA_TARGETS` (`src/cli/schema.ts`).
  - Test-only commands are files in `test/helpers/commands/test/<name>.ts`. They are exposed as `ghx test <name>` only under `GHX_TEST_HOOKS=1`, and contract tests use them, for example for exit 1.
  - Passthrough (M7.1) replaces `onUnknown` in `src/cli/unknown.ts`. It returns `{kind: 'run', spec, input}`, which runs a synthetic spec through `runCommandWith` with no ghx flag parsing, or `{kind: 'refuse', error}`. The read guard (`src/gh/guard.ts`) already allowlists 02 §10's reads.

**Notes for later waves:**
- Config sections use 02 §15 names. 01's `checks.ignore` is `ci.ignore`, and 01's `pr.title` and `pr.render` are the empty `title` and `render` sections.
- A spill keeps the command's own exit code. Today this differs from 01's literal "exit 0" only for a failing doctor.
- SIGHUP and EPIPE exit 143, like SIGTERM.
- `gh` is reached only through `ctx.gh` (`src/gh/index.ts`):
  - REST goes through `api()` and `apiText()`, which always pass `--include`. A 304 comes back as `notModified`.
  - GraphQL goes through `graphql()` and `graphqlPartial()`. Reads send the query as `-f query=…`; mutations send a JSON body.
- The harness builds its environment from scratch. Without `git` or `proc`, it uses an in-memory "not a checkout" git.
- `pnpm check` runs typecheck, lint and tests. Contract tests spawn `bin/ghx.js`.
- **Rethrow control flow from every catch-all.** `DryRunHalt`, `INTERRUPTED`, `TIMEOUT` and `AbortError` are ordinary throws that the runner turns into the dry-run result, the interrupted summary or the timeout error. A handler's `catch (e)` that turns failures into warnings or partial results must let them through first: `try { … } catch (e) { rethrowControlFlow(e); /* handle the rest */ }`. Use `isControlFlow(e)` when you need a boolean. Both live in `src/core/control-flow.ts`. Stream handlers that build a graceful `interrupted` summary still use `isAbort()` from `src/core/signals.ts`, and must rethrow `DryRunHalt`.
- **Write commands must ship a smoke scenario.** The registry smoke run now requires a GitHub-mutating write's `examples[0] --dry-run` to reach the halt and print `{dryRun: true, wouldRun}`. Against the default 404 gh, a write fails its reads first, so ship `test/fixtures/gh/smoke/<name-with-dashes>/` with the reads it needs. Writes that change only local files go in `LOCAL_WRITES` in `test/registry.test.ts` (today only `init`).

## Coordinator decisions during the build

- **2026-10-22, spill exit code.** A spilled document keeps the command's own exit code. This supersedes "exit 0" in 01 and 02 §1.3. A failing command must not read as a success just because its output was large.
- **2026-10-22, wave 1 additions accepted.** These are:
  - `CONFIG_EXISTS` (exit 3);
  - SIGHUP and EPIPE exit 143;
  - the directory-scanned registry;
  - `summarySchema`;
  - `MIN_GH_VERSION` 2.81.0.
- **2026-10-22, unverified addressed findings (for M6.4 and M8).** Merge policy fails closed.
  - `pr merge` and `merge.ready` verify **every** addressed event whose finding is at or above `merge.blockOnSeverity`, with no 10-commit cap. Merges are rare, so the extra compare calls are acceptable.
  - A finding whose addressed commit is still `verified:null` after that counts as **open** for blocking purposes.
  - `pr status` and `pr feedback` keep the 10-commit cap. Those findings show `verified:null` with `EVENT_COMMIT_UNVERIFIED`.
- **2026-10-22, wave 2b feedback choices accepted.**
  - An empty COMMENTED review is a container for its comments and is not listed.
  - Order is inline, then review, then issue, then by time.
  - GraphQL bot logins are normalised to `login[bot]`.
  - New warnings: `EVENT_INVALID`, `EVENT_TARGET_UNKNOWN` and `EVENT_COMMIT_UNVERIFIED`.
- **2026-10-22, wave 2b create choices accepted.**
  - Block keys are sorted, because the codec owns the wire order.
  - Each issue in the trailer gets its own `closes` keyword.
  - `scopeRequired` defaults to false.
  - Commands under `/usr`, `/bin`, `/sbin` and `/dev` are re-runnable.
- **2026-10-22, wave 3 pr-create choices accepted.**
  - Fork heads (`owner:branch`) are out of v1.
  - `viewerPermission` READ/TRIAGE gives `GH_FORBIDDEN`, as 02 §6.2 says.
  - Config is read from the default branch, not from `?ref=<base>`; revisit if stacked bases diverge.
  - Prose fields are JSON-only (`.meta({jsonOnly:true})`).
- **2026-10-22, wave 3 wait-pure choices accepted.**
  - A skipped sibling job doesn't count as "started" for the queued-stall rule.
  - `ci.expected` and `ci.stall` are optional, with defaults in `stallConfig()`.
- **2026-10-22, CI_PENDING spec conflict (wave 3 review #1).** 02 §11.2/§11.3 win over §8.2 row 10a. Merge policy blocks whenever `ci.state === 'pending'`, including when only baseline checks are missing. Baseline checks stop blocking only once `expectedState(…, agedOut)` has aged them out. The engine also fails `CI_PENDING` when `ci.headSha !== snapshot.head.sha`.
- **2026-10-22, key steps.** `src/ci/key-steps.ts` is canonical, and `src/policy/key-steps.ts` is removed. A configured `ci.keySteps` with unreadable job data fails closed.
- **2026-10-22, shared CI-summary composition.** The pr-status agent builds it as a reusable module, `src/pr/ci-summary.ts`. `pr merge` and `ci wait --until mergeable` must call that module rather than reassembling it.
- **2026-10-22, wave 4 review decisions.**
  - **Wait-state lock.** This supersedes 03 M4.6's whole-wait lock. The lock covers only load and save of the state file: brief, taken in sorted key order, and bounded. Concurrent waits on the same target each poll on their own, and the ETag cache makes the duplicate polls cheap. A waiter never blocks past the self-return time.
  - **Wait-state key.** The key includes `boundSha`, as 02 §11.1 says. A saved `terminal` is honoured on resume. If the head moved, the wait binds fresh. The stored expected set is unfiltered, and `--check` filters are applied when observing.
  - **Branch targets.** The expected set for `branch:` targets is config entries plus the baseline from the previous commit on that branch. It excludes rules or branch-protection required contexts, because those are PR-only.
  - **One check set.** `ci wait` and `pr status` must count the same checks. The GraphQL `statusCheckRollup` is canonical. REST check-runs that aren't in the rollup, such as reviewer apps like `copilot-pull-request-reviewer`, are dropped.
  - **`pr status` size.** The 16 KB bound is hard. Once body blanking isn't enough, whole old or resolved comment entries are dropped, and `omitted` counts them with a `pr feedback` hint.
  - **`pr status` quiet branch.** It reads the cached `required:<base>` set so required checks that never registered stay visible, and warns on a cache miss.
  - **02 §11.2 table.** The default until-mode is `first-failure`; the table's "settled (default)" is a spec typo.
- **2026-10-22, final review decisions.**
  - **Wait-state expiry** uses `max(settledAt, savedAt) + 24h`. This corrects 02 §11.1's literal "24 h after CI completed", which deleted fresh state for old PRs. Any resumed tick that isn't a 304 clears the saved terminal.
  - **Baseline grace and stall timing** are both measured from CI time, never from first observation. Baseline names are filtered through the rollup, per the one-check-set decision.
  - **`--until mergeable`** evaluates the full required set and ignores `--check` filtering, so required checks always gate merge readiness. A persistent `UNKNOWN` keeps polling, by design.
  - **Raw gh writes with a leading `-R`/`--repo`.** `permissions.deny` prefix rules can't match them. The hook therefore always returns `deny` for wrapped *writes* wherever the repo flag sits, independent of `GHX_HOOK_MODE`; that mode keeps governing read suggestions (default ask). `hooks.md` documents why both the hook and the deny list are needed.
  - **`ci rerun --flaky` never widens** to `rerun-failed-jobs` unless every red job in the run is a candidate.
  - **`ci retrigger`.** Once a close may have landed, the reopen runs on a gh client detached from the runner's abort signal, inside the shutdown grace window. If it still fails, the result is `REOPEN_FAILED` with `closedAt`.
  - **`pr comment --close`** gets an overridable `AUTHOR_NOT_VIEWER` guard, matching `ci retrigger`.
  - **`openFindings`** in `pr status` and `pr feedback` means "blocks merge". That includes unverified addressed findings at blocking severity, so it matches the policy engine.
  - **`pr feedback --open` never drops a blocking finding for being outdated**, with or without `--include-outdated`. "Blocks merge" is `openFindings`' definition: open at or above `merge.blockOnSeverity`, or addressed there with an unverified commit. `--include-outdated` governs only outdated findings that don't block.
  - **Acceptance scorer.** "≤5 GitHub calls end to end" is informational. A metric with nothing to measure reports `null`, not pass. Raw gh CI polling fails the CI-wait metric.
  - **`--schema` output** is exempt from spill, because it's documentation.
- **2026-10-23, post-push fixes (`0dc974f`..`6669805`).**
  - `pr status` derives the expected set exactly as `ci wait` does: required checks cached for 1 h, baselines via `baseline:v2:`. This supersedes the "pr status quiet branch… warn on a cache miss" decision, and `REQUIRED_CHECKS_UNCACHED` is removed.
  - The interrupted `ci wait` summary carries `ci.observed:false` when nothing has been observed yet.
  - New non-overridable policy blocker `NO_MERGE_PERMISSION`. It fails closed, so it also blocks when GitHub reports `viewerPermission: null`. Its hint must say so.
  - `ci wait --until mergeable` keeps its 6–12 scope and doesn't evaluate it.
