# 05: Build handoff (spin-down 2026-10-22, ~16:30 CT)

This is a resume point for the coordinator session after the API usage limit resets. Read it together with `04-build-coordination.md`: its rules, extension points, and all "Coordinator decisions". The **final review decisions** entry governs the open work.

## Where things stand

- **The v1 command set is built and committed on `main`.**
  - CI: `ci why`, `ci wait` (including `--until mergeable`), `ci rerun`, `ci retrigger`.
  - PRs: `pr status`, `pr feedback`, `pr create` (including `--batch`), `pr edit`, `pr comment`, `pr review`, `pr resolve`, `pr merge`.
  - Plumbing: passthrough, `doctor`, `init`, `version`, `schema`, `hook claude-pretooluse`.
  - Agent docs are in `docs/agents/`.
- **Testing.** The last full green run had about 1,937 tests and 98% line coverage. Waves 1–4 each had a review and a fix pass. Three final reviews ran: write path, wait/passthrough/hook, and definition of done.
- **GitHub.** `origin/main` is at `aa04df7`. Everything after that is **local only**, and the user must approve any push (global rule: ask every time).
- **Open work:** three final-fix batches were in flight at spin-down. All three agents stopped cleanly, and the working tree is clean: no half-done edits.
  - Landed since `16cdf1a`:
    - `c068f99` W1
    - `761c82d` W2
    - `a58acdb` W3a
    - `19548e7` R1 (retrigger reopen on a detached gh view, `Gh.detached(signal)`, plus a `CLOSE_UNCONFIRMED` warning)
    - `01b39fa` D5
  - **The full `pnpm check` has not been run since these landed. Run it first.**

## Final-fix batches (the specs are the final review decisions in 04)

### Batch W: `ci wait`
Owns `src/ci/wait/**` and `src/commands/ci/wait.ts`.
1. Clear a stale terminal after `ci rerun`. Done in `c068f99`.
2. Wait-state expiry is `max(settledAt, savedAt) + 24h`. Done in `761c82d`.
3. **3a is done (`a58acdb`).** Still open: **3b**, filtering baseline names through the rollup. Bump the baseline cache key, or a stale 24 h cache will hide the fix. `src/pr/ci-summary.ts` also calls `fetchBaseline`, so re-run the pr-status and pr-merge tests. Target: a long-settled PR returns in seconds, where today it takes about 100 s.
4. `next` uses `branch:<name>@<boundSha>`.
5. `--until mergeable` ignores `--check` for the required set.
6. Lows:
   - merge `reported` sets on save;
   - add `--no-compare-main` to the honour key;
   - under `--any`, report the reason correctly;
   - cap warning length.
7. Live check (read-only, `cli/cli`): run a settled PR twice and confirm `resumed:true` and a fast return. Also run `branch:trunk`.

### Batch R: write path, hook, passthrough
1. **M1 is done (`19548e7`).** One known limit remains: after SIGINT or SIGTERM the PR is reopened, but the output still reads INTERRUPTED, because `src/core`'s runner always reports that. An optional follow-up is to surface the reopen outcome in the interrupted summary.
2. **M2, `ci rerun --flaky` never widens** to non-candidates.
3. **`openFindings` means "blocks merge"** in both `pr status` and `pr feedback`.
4. **Wrapped writes are always denied by the hook**, including the `-R`/`--repo` forms wherever the flag appears. Update `docs/agents/hooks.md` to match.
5. Lows:
   - `pr merge --dry-run` on an already-merged PR returns `{dryRun:true}`;
   - a 409 with an unchanged head should not report `HEAD_MOVED`;
   - `pr comment --close` gets an `AUTHOR_NOT_VIEWER` guard;
   - fix the flaky `pr-merge-branch.test.ts:102`;
   - update 02 §3 to say `CONCURRENT_EDIT` covers title and body;
   - passthrough edge cases: `run download --name -D`, `-cw`/`-vw`, `pr co`;
   - doc wording: the exit-11 text, first-failure continuation, and removing the "§6.1" citations;
   - regenerate the docs with `pnpm docs:gen`.

### Batch D: definition of done
1. Add `.github/ghx.json` and `test/dogfood-config.test.ts`, and make the `ghx init` starter more useful. The starter lives in `src/config/starter.ts`, and `test/commands/init.test.ts` pins it exactly. The config is strict JSON, so it can't hold comments.
2. Add `test/error-coverage.test.ts`. Planned fix: raise `ENV_GIT_MISSING` in `init` and drop `ENV_GH_TOO_OLD`, since `doctor` already reports an old gh with exit 4. Test `ENV_GH_AUTH` end to end.
3. Add contract tests for exits 5, 9, and 11–14.
4. Scorer changes:
   - the end-to-end call count is informational only;
   - metrics with nothing to measure report `null`;
   - raw gh CI polling fails the CI-wait metric;
   - re-run it read-only on 3 real sessions.
5. **Done (`01b39fa`).** `--schema` output is exempt from spill.
6. README: add `doctor`, `init`, `version`, `schema` and `hook` to the command table. Remove the stale comment in `ci.yml`.

## Resume procedure

1. Run `git status --short` and `git log --oneline 16cdf1a..HEAD`, then map the result onto the lists above. Uncommitted files belong to the item named as in progress.
2. Respawn one agent per batch that still has open items. Use the batch lists above and the rules in 04: pathspec commits, never push, and each fix needs a test that fails before the fix. Partial uncommitted work should be finished or replaced, never committed blindly.
3. When all batches are in, run one quick read-only verification pass:
   - `pnpm check` and `pnpm test:coverage` on a `git archive HEAD` export;
   - live read-only runs: `ci wait` twice on a settled `cli/cli` PR, and the hook with `gh -R o/r pr merge 1`.
4. Ask the user with the AskUserQuestion tool whether to push `main`.
5. **Acceptance (03 §8.2, v1).**
   - The user installs the agent snippet and hook from `docs/agents/` and works three real PRs with ghx.
   - Then run `scripts/acceptance/score.ts` over those session JSONLs.
   - Real sessions before ghx score as failures, which is expected: they make 11–31 raw gh calls each.

## User preferences that apply (memory)

- Ask decisions with **AskUserQuestion**, never as prose questions.
- Don't ask the user how Claude Code works. Research it and decide.
- Work on `main` with no branches or worktrees. Keep parallel agents on disjoint files.
- Commit freely. **Ask before every push.**
