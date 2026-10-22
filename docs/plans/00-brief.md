# Planning brief: gh-for-agents

Shared decisions for the scaffolding, API, and implementation/testing plans.
Every plan must be consistent with this file and cite
`docs/research/gh-usage-findings.md` (§N) for its design choices.

## Goal

A CLI that agents call instead of `gh`. It wraps `gh` (shells out to it; gh
owns auth, host resolution, and the HTTP layer), adds strict validation on
writes, and answers each common question in one plain invocation on reads.

## Pinned decisions

1. **Runtime.** TypeScript on Node 24, ESM. zod schemas are the single source
   of truth for inputs and outputs. They drive validation, typed output, and
   machine-readable help (`<cmd> --schema` prints JSON Schema). Overridable
   by the user. The planners don't revisit it.
2. **Binary name.** `ghx` (working name).
3. **Output contract.**
   - JSON on stdout by default, bounded in size.
   - Large artifacts (logs, diffs) go to files, and the command returns the
     paths (§9.10).
   - Errors are a structured JSON object on stdout with a non-zero exit code:
     `{error: {code, message, hint, details}}`. Exit codes are distinct per
     class.
   - Reads never mutate. Writes never fall back silently.
   - No pager and no interactive prompts, ever.
4. **One plain invocation per question** (§9.7). Callers should never need
   pipes, `--jq`, `head`, sleeps, or `timeout`. Timeouts and polling run
   in-process, because macOS has no `timeout` (§0, §5.2).
5. **Structured PR bodies, compact rendering.** This resolves the tension in
   §4.1.
   - Input is validated JSON (stdin or file):
     `{title, description, testing, risk, components, revertPolicy, base, head, draft?, refs?}`.
     - `description` is at most 3 lines.
     - `testing` is a structured list (for example
       `{kind, command?, result, notes?}`). It must be able to tell a reader
       how to run the tests.
     - `risk` and `revertPolicy` are global enums.
     - `components` come from a **per-repo** enum (see 6).
   - The rendered body is the description, plus one compact trailer line
     (risk, components, revert policy, test summary), plus the attribution
     footer. The user has corrected agents twice toward "2–3 sentences, no
     sections, no test logs", so a sectioned body is out.
   - The full structured object is embedded in a hidden block:
     `<!-- ghx:v1 {json} -->`. GitHub doesn't render HTML comments.
6. **Per-repo config.** A file at the repo root, `.ghx.json` (exact name is
   the scaffolding planner's call), declares:
   - `components` (enum values, optionally mapped to path globs)
   - noise checks to ignore
   - merge method (default `merge`; squash only with an explicit override,
     §4.3)
   - rendering policy
   - other repo-specific knobs

   The tool validates the config itself and fails clearly when it's missing
   or invalid.
7. **Read side folds everything into one object.** `pr status` (or
   `pr view`; naming is the API planner's call) returns:
   - description
   - parsed `ghx:v1` metadata
   - merge state
   - CI summary for the head SHA
   - feedback merged from all 3 GitHub sources (§8b)
   - preconditions
   - stack info

   Comments and reviews written by ghx carry their own `ghx:v1` block (review
   findings, coordination comments with preconditions; see the schema in
   §8c). PRs, comments, and bot output **without** a block are returned with
   `structured: false`. They are never dropped. Bots are separated out.
8. **v1 scope.** Recommendations 1–6 and 8 from §9:
   - `ci why`
   - `ci wait`
   - `pr status`
   - structured `pr create`
   - policy-driven `pr merge`
   - `pr feedback` / structured `pr comment` / `pr review`
   - `ci rerun` / `ci retrigger`

   Items 9 and 10 are cross-cutting requirements, not separate commands.
   "Also worth having" items are out of v1 unless they're cheap.
9. **Open for the API planner.**
   - Passthrough policy: unknown subcommands either exec real `gh`, are
     refused, or are allowlisted. Decide and justify.
   - Exact command names.
   - Flag versus stdin JSON for each command.
   - Exit-code table.
   - The hidden-block schema, versioning included.

## Known gh gotchas to design around

- `gh run view --log` refuses while a run is in progress. The jobs-logs REST
  API is the primary path, not a fallback (§0, §5.1).
- `mergeable` is `UNKNOWN` right after a push. Retry it with a bound (§9.3).
- `pr diff` fails beyond 300 files with HTTP 406 (§9.10).
- Base branches get auto-retargeted when the parent merges (§4.1).
- A cwd repo that doesn't match the PR's repo causes failures, as with
  sektar #3258 (§4.1).
- Merges must pin `--match-head-commit`. Only 8 of 52 did (§4.3).

## Decisions confirmed by the user (2026-10-22)

The user confirmed these after the scaffolding plan's Pushback section:

- **Runtime:** TypeScript on Node 24.
- **Binary name:** `ghx`.
- **Config location:** `.github/ghx.json`. This supersedes `.ghx.json` in item 6.
- **Agent steering:**
  - Writes: `permissions.deny` rules block raw `gh pr merge/create/edit/review/comment`.
  - Reads: an optional PreToolUse hook suggests `ghx`. It runs in ask mode and fails open.
  - Both ship as an opt-in late commit.
- **Accepted from the 01-scaffolding pushback:**
  - JSON input arrives only through `--input <file>` or an explicit `--input -`.
  - stdout takes one of three shapes:
    - a single bounded JSON document
    - NDJSON ending in a `summary` or `error` line
    - a spill result `{spilled, path, bytes}`
  - The error object always has all four keys, with `null` for empty ones.
  - There is no user-level config.
  - Read commands get a gh client that is mechanically read-only.
