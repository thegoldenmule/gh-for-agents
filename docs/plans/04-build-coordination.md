# 04: Build coordination

This file explains how the v1 build is split across subagents. Read it together with `00-brief.md` (read to the end; the decision sections override the body), `01-scaffolding.md`, `02-api.md` and `03-implementation.md`. 03's appended decisions override 03's body.

## Rules for every implementer

1. **Work on `main` in the shared working tree.** Don't create branches or worktrees, and never push. Commit freely in small logical commits, one per 03 commit-list item, using that item's message. End each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
2. **Stay inside your owned paths** (see the wave table). Stage with `git add <your paths>` only, never `git add -A` or `git add .`. If `git commit` hits `index.lock`, wait a few seconds and retry. Never run `git stash`, `reset`, `checkout -- <file>`, `rebase` or `clean`, because other agents' uncommitted work is in the same tree.
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

- Commands:
- Error codes:
- Fixture scenarios:
- Config keys:
