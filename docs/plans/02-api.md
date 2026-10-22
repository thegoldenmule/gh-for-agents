# 02: ghx command API

Status: draft. Depends on `00-brief.md`. Evidence comes from `docs/research/gh-usage-findings.md`, cited as §N. The scaffolding plan (01) owns the framework, exec layer, config loader and block codec. This file owns **what** the commands are and their contracts.

---

## 0. Decisions at a glance

| Topic | Decision | Evidence |
|---|---|---|
| v1 commands | `pr create` (`--batch`), `pr edit`, `pr status`, `pr feedback`, `pr comment`, `pr review`, `pr resolve`, `pr merge`, `ci why`, `ci wait`, `ci rerun`, `ci retrigger` | brief 8; §9.1–9.6, §9.8; `pr edit` is justified in Pushback |
| Read verb | `pr status`. `pr view` is refused, with a hint naming `pr status` | §9.3; 534 `pr view` calls by habit (§2.1) |
| Flags vs JSON | Identifiers, modes, durations and overrides are flags. Any prose (titles, descriptions, bodies, findings) is JSON on stdin or `--input <file>` | §4.1: 23 heredoc and 19 inline bodies, escaped backticks, a refused `printf`, title drift on retry |
| PR selector | `N`, `#N`, `owner/repo#N` or a PR URL. Every output carries `ref: "owner/repo#N"` | §3.1 and §4.1, sektar #3258 |
| Read/write split | Reads (`pr status`, `pr feedback`, `ci why`, `ci wait`) never mutate. The one exception is `ci wait --rerun-flaky` (see Pushback) | §3.2, §9.7 |
| Passthrough | Allowlisted read-only gh subcommands run real `gh` inside a bounded JSON envelope. Commands that have a wrapped replacement are refused with a hint. Writes and unknown commands are refused | §2.4, §3.2, §7, §9.9 |
| Hidden block | `<!-- ghx:v1 {json} -->` with 4 types (`pr`, `review`, `finding`, `comment`). Writes use strict schemas and reads use lenient ones. Status changes are append-only events | §8c |
| Trust | A block is honoured only when its author is `OWNER`, `MEMBER` or `COLLABORATOR` (configurable) | Defends against prompt injection |
| Merge | REST `PUT /pulls/N/merge` with `sha` pinned. The policy engine is shared with the `merge.blockers` field of `pr status`. Overrides are given as a code plus `--reason` | §4.3, §7 |
| `ci wait` | NDJSON transition events, an expected-check model, a diagnosis folded into the terminal event, ETA, multiple targets and flake signals. The default timeout is 8m, and `--max` serves background runs | §5.2, §9.2; §11 |

Gotcha tags used in the gh-call lists:
- **[G-LOGS]**: `run view --log` refuses mid-run, so use the jobs-logs REST endpoint (§0, §5.1).
- **[G-UNKNOWN]**: `mergeable` is `UNKNOWN` right after a push, so retry with a bound (§5.2, §9.3).
- **[G-300]**: diffs and compares cap at 300 files (§3.1, §9.10).
- **[G-RETARGET]**: GitHub auto-retargets bases (§4.1).
- **[G-CWD]**: the cwd repo may not match the PR's repo (§3.1).
- **[G-SHA]**: pin the head SHA (§4.3, §5.4).

---

## 1. Conventions shared by all commands

### 1.1 Grammar and global flags

The grammar is `ghx <noun> <verb> [selector…] [flags]`, where noun ∈ `pr`, `ci`.

| Flag | Applies to | Meaning |
|---|---|---|
| `-R, --repo owner/name` | all | Explicit repo |
| `--input <path\|->` | writes | JSON input. If omitted, ghx reads stdin when it is not a TTY. A TTY stdin gives `INPUT_MISSING`, never a prompt (brief 3) |
| `--dry-run` | writes | Runs all validation, policy and read calls but no mutation, prints the plan, and exits as the real call would |
| `--expect-head <sha>` | `pr merge`, `pr review`, `ci rerun`, `ci retrigger` | Refuse with `HEAD_MOVED` if the head is not this SHA (7–40 hex chars) **[G-SHA]** |
| `--schema` | all | Prints `{input, output, errors, mutates}` as JSON Schema. Makes no network calls |
| `--pretty` | all | Indented JSON |

There is no `--json`, `--jq`, `--web`, `--watch` or pager. Every output has a fixed, typed schema, which makes field-name errors impossible (§3.1 "Unknown JSON field", §9.9).

### 1.2 Repo and PR resolution [G-CWD]

1. The repo comes from the selector (`owner/repo#N` or a URL), then `--repo`, then the cwd. For the cwd, ghx runs `gh repo view --json nameWithOwner`, which honours gh's remote and default-repo rules.
2. If the selector's repo and `--repo` disagree, the command fails with `INPUT_INVALID`.
3. If the repo came from the cwd and the PR isn't found, the command fails with `PR_NOT_FOUND`. The hint names the cwd-derived repo and suggests the `owner/repo#N` form. This is the sektar #3258 case (§3.1).
4. If an explicit repo differs from the cwd repo:
   - Reads proceed and add the warning `CWD_REPO_MISMATCH`.
   - Writes that consult local git (the `pr create` unpushed check and components fallback) skip the local step and warn.
5. Every output includes `ref`. Suggested follow-ups (`next[]`) are written as `ref`-based commands.

### 1.3 Output envelope

- **Success:** the command's output object. It always includes `ref` (where applicable) and `warnings: {code, message}[]`.
- **Error:** `{"error": {"code", "message", "hint", "details"}}` on stdout, with a non-zero exit code (§6).
- **Size bound:** 32 KB per stdout payload. Commands truncate item bodies (marked `truncated: true`) and write full artifacts to files under the scaffolding artifact dir, returning `*Path` fields. Basis: brief 3; §6 found 147 results over 5 KB and 131 logs saved to files.
- **Exception:** `ci wait` writes NDJSON. Each line is one JSON object, and the last line is the result (§11; see Pushback).

### 1.4 IDs

- ghx ids are a prefix plus 6 lowercase Crockford base32 characters. Prefixes: `p_` (PR block), `r_` (review), `f_` (finding), `c_` (comment).
- Regex: `^[prfc]_[0-9a-hjkmnp-tv-z]{6}$`.
- ghx generates them client-side before posting. They are unique per PR.
- Unstructured GitHub items get synthetic ids: `ic:<databaseId>` (issue comment), `rc:<id>` (review comment) and `rv:<id>` (review).

### 1.5 Shared schemas (zod-ish)

```ts
const Sha        = z.string().regex(/^[0-9a-f]{40}$/);
const ShaInput   = z.string().regex(/^[0-9a-f]{7,40}$/);           // resolved to full via API
const PrRef      = z.string().regex(/^(?:[\w.-]+\/[\w.-]+)?#\d+$/); // "#123" | "owner/repo#123"
const IssueRef   = PrRef;
const Iso        = z.string().datetime();
const OneLine    = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\r\n]/.test(s), "single line");
const RepoPath   = z.string().min(1).max(400).refine(p => !p.startsWith("/") && !p.split("/").includes(".."));
const Duration   = z.string().regex(/^\d+(s|m|h)$/);                // "90s", "8m", "1h"
const Warning    = z.object({ code: z.string(), message: z.string() });

// Built at runtime from the repo config (.ghx.json; name per 01):
const Component  = z.enum(config.components.map(c => c.name));

const Risk         = z.enum(["trivial", "low", "medium", "high"]);
const RevertPolicy = z.enum(["revert-safe", "revert-with-followup", "coordinated", "forward-fix-only"]);
const Severity     = z.enum(["high", "medium", "low"]);
const Verdict      = z.enum(["approve", "request-changes", "comment"]);
const FindingStatus      = z.enum(["open", "addressed", "wontfix", "deferred"]);
const PreconditionStatus = z.enum(["met", "unmet", "unknown", "withdrawn"]);

const Author = z.object({
  login: z.string(), isViewer: z.boolean(), isBot: z.boolean(),
  association: z.enum(["OWNER","MEMBER","COLLABORATOR","CONTRIBUTOR","FIRST_TIME_CONTRIBUTOR","FIRST_TIMER","MANNEQUIN","NONE"]),
});
```

**Risk** is a global enum. It is rendered in the trailer. `pr merge` reads it only for warnings.

| Value | Definition |
|---|---|
| `trivial` | No runtime behaviour change: docs, comments, test-only changes, or CI config that does not gate releases |
| `low` | Behaviour change inside one component, covered by the listed tests, and revertible on its own |
| `medium` | Behaviour change across components or in a shared or public API, or only partial test coverage. Requires `riskNote` |
| `high` | Touches persisted data formats or migrations, auth, crypto or signing, or the release/publish pipeline, or is hard to revert. Requires `riskNote` |

**Revert policy** is a global enum.

| Value | Definition | Extra field required |
|---|---|---|
| `revert-safe` | A `git revert` of the merge commit fully undoes the change. Nothing else is needed | none |
| `revert-with-followup` | Revertible, but something else must also happen (a config flip, cache purge or re-publish) | `revertNote` |
| `coordinated` | Revert only together with other PRs: stack slices or cross-repo pairs. 16 of 73 PRs were stacked (§4.1) | `revertWith: PrRef[]`, at least one |
| `forward-fix-only` | Do not revert. Fix forward instead (a released package, applied migration or published data format) | `revertNote` |

**CI summary.** `pr status`, `ci why` and `ci wait` all share this schema. It is defined once here.

```ts
const Bucket = z.enum(["pass","fail","pending","skipped","cancelled","neutral"]);
const Check = z.object({
  name: z.string(), workflow: z.string().nullable(),
  kind: z.enum(["actions","status","app"]),        // Actions job | commit status | other check app
  bucket: Bucket,
  status: z.enum(["expected","queued","in_progress","waiting","completed"]),
  conclusion: z.string().nullable(),
  required: z.boolean(),
  runId: z.number().nullable(),                    // checkSuite.workflowRun.databaseId (no link parsing, §2.3)
  jobId: z.number().nullable(),                    // CheckRun.databaseId == Actions job id
  attempt: z.number().nullable(),
  url: z.string().url(), startedAt: Iso.nullable(), completedAt: Iso.nullable(),
});
const SameOnMain = z.object({
  verdict: z.enum(["same-tests","same-step","different","main-green","no-main-run","not-compared"]),
  mainBranch: z.string(), mainRunId: z.number().nullable(), mainSha: Sha.nullable(), mainRunAt: Iso.nullable(),
  prTests: z.array(z.string()).max(30), mainTests: z.array(z.string()).max(30),
  newTests: z.array(z.string()).max(30),           // failing on PR, not on main
});
const Flake = z.object({
  candidate: z.boolean(), score: z.enum(["high","medium","low","none"]),
  signals: z.array(z.object({
    kind: z.enum(["same-sha-passed","main-intermittent","known-flaky","infra-error"]),
    detail: z.string(),
  })),
});
const FailingCheck = Check.extend({ sameOnMain: SameOnMain.nullable(), flake: Flake.nullable() }); // null = not computed
const ExpectedCheck = z.object({
  name: z.string(), workflow: z.string().nullable(),
  source: z.enum(["required","config","baseline"]),
  state: z.enum(["missing","reported","absent"]),  // absent = baseline check aged out (path-filtered)
});
const CiSummary = z.object({
  headSha: Sha, forHeadSha: z.literal(true),       // ghx never reports CI for another SHA
  state: z.enum(["green","red","pending","no-checks"]),
  phase: z.enum(["registering","partial","running","settled"]),
  counts: z.object({ pass: z.number(), fail: z.number(), pending: z.number(), skipped: z.number(),
                     cancelled: z.number(), neutral: z.number(), ignored: z.number() }),
  failing: z.array(FailingCheck),
  pending: z.array(Check.pick({ name: true, workflow: true, status: true, required: true })),
  ignored: z.array(z.string()),                    // config noise checks (§6: notify-discord, CI duration watch)
  expectedMissing: z.array(ExpectedCheck),         // includes required checks not yet reported
  eta: z.object({ seconds: z.number(), p90Seconds: z.number(), basis: z.string() }).nullable(),
  next: z.array(z.string()),
});
```

Rules applied to the summary:
- Duplicate check rows from re-runs collapse to the latest attempt per (workflow, name). §6 records these duplicate rows.
- `cancelled` counts toward `red`.
- `state` and `phase` follow §11.3.

**Shared with main.** There is one definition, used by `ci why`, `ci wait`, `pr status` and `pr merge`.

- **Which branch:** the repo's default branch, not the PR's base. Stacked PRs have feature branches as their base (§4.1).
- **Which run:** the latest *completed* run of the same workflow file on that branch, with `event=push` and `head_sha ≠ PR head`.
- **When a failing PR job counts as shared:** that main run has a job with the same name that concluded `failure`, and one of these holds:
  - `same-tests`: the PR's extracted failing-test set is non-empty and is a subset of main's.
  - `same-step`: neither side yields test names, and the failing step names are equal.
- A job-name match alone never counts. Otherwise a new failure inside an already-failing job would be waived. See §4.3 "merge when main shares red" and §7 #3246.

---

## 2. `pr create`

```
ghx pr create [--input pr.json|-] [-R owner/repo] [--dry-run]
ghx pr create --batch [--input prs.json|-] [-R owner/repo] [--dry-run]
```

Purpose: open a PR from a validated, structured object. The body is rendered as description, trailer, footer and hidden block.

### 2.1 Input

```ts
const TestingItem = z.object({
  kind: z.enum(["unit","integration","e2e","typecheck","lint","build","benchmark","manual"]),
  command: OneLine(200).optional(),                // what a reader runs, verbatim
  cwd: z.string().max(120).regex(/^(?!\/)(?!.*\.\.)[\w@.\/-]+$/).optional(), // repo-relative dir
  steps: z.array(OneLine(160)).min(1).max(5).optional(),  // manual reproduction steps
  result: z.enum(["pass","fail","skipped","not-run"]),
  notes: OneLine(200).optional(),
}).strict();

const Refs = z.object({
  stackedOn: PrRef.optional(),
  closes: z.array(IssueRef).max(10).optional(),
  related: z.array(PrRef).max(10).optional(),
  splitFrom: PrRef.optional(),
  supersedes: z.array(PrRef).max(10).optional(),
  reverts: PrRef.optional(),
}).strict();

const PrCreateInput = z.object({
  title: z.string(),
  description: z.string(),
  testing: z.array(TestingItem).min(1).max(10),
  risk: Risk, riskNote: OneLine(160).optional(),
  components: z.array(Component).min(1).max(5),
  revertPolicy: RevertPolicy, revertNote: OneLine(200).optional(),
  revertWith: z.array(PrRef).max(10).optional(),
  base: z.string().min(1).max(255),
  head: z.string().min(1).max(255),                 // "branch" or "owner:branch" for forks
  draft: z.boolean().optional(),                    // default derived (2.4)
  refs: Refs.optional(),
}).strict().superRefine(createRules);
```

**Validation rules (`createRules`).** All violated rules are reported together in `details.issues[]` as `{path, code, message}`.

| Path | Issue code | Rule |
|---|---|---|
| title | `title.format` | Must match `^(?<type>feat\|fix\|docs\|refactor\|perf\|test\|build\|ci\|chore\|revert\|style)(\((?<scope>[a-z0-9][a-z0-9-]*)\))?(?<bang>!)?: (?<subject>\S.*)$`. Types are configurable. 71 of 73 titles are already conventional (§4.1) |
| title | `title.too_long` | At most 72 code points for the whole title. 40 of 73 titles were over 72; the median was 74 (§4.1) |
| title | `title.scope_missing` | A scope is required (config `title.scopeRequired`, default true). Missing scopes were seen in §4.1 |
| title | `title.multi_scope` | A comma inside the scope is refused (e.g. `codegen,vetra`, §4.1). Put extra components in `components` instead |
| title | `title.scope_not_component` | The scope must be one of the config components |
| title | `title.scope_not_declared` | The scope must be in `input.components` |
| title | `title.pr_suffix` | No trailing ` (#N)`. GitHub adds it on squash, and series tags waste the length budget (§4.1) |
| title | `title.whitespace` / `title.trailing_period` | No leading, trailing or double spaces, and no trailing `.` |
| title | `title.revert_needs_ref` | Type `revert` requires `refs.reverts` |
| description | `description.lines` | 1–3 lines after trimming, with no blank lines. It is one paragraph, and GitHub renders single newlines as line breaks |
| description | `description.too_long` | At most 500 chars (config `render.descriptionMaxChars`). After the user's correction the median body was 568 chars *including* the ~65-char footer (§4.1) |
| description | `description.markdown_structure` | No line may start with `#`, `- `, `* `, `+ `, `N. `, `>` or `\|`. No fenced code, `<details` or `<!--`. This encodes the user's corrections: "no headings, bullet sections, file lists or test-result logs" (§4.1) |
| description | `description.footer` | Must not contain the attribution footer or a `ghx:` marker. ghx adds both |
| testing | `testing.min_pass` | At least one item must have `result: "pass"` (config `create.requirePassingTest`, default true) |
| testing[i] | `testing.command_required` | `kind ≠ manual` requires `command` |
| testing[i] | `testing.steps_required` | `kind = manual` requires `steps` |
| testing[i] | `testing.not_rerunnable` | `command` or `cwd` contains an absolute or home path (`/Users/`, `/home/`, `/private/tmp`, `/tmp/`, `~/`, `C:\`) |
| testing[i] | `testing.compound_command` | Refuses an unquoted `\|`, `;`, `&&`, `>`, `<`, backtick or `$(`. Record the command a reader would run, not how you filtered its output (§6: 1,114 filtered commands). Use `cwd` instead of `cd … &&` |
| testing[i] | `testing.notes_required` | `result` of `fail`, `skipped` or `not-run` requires `notes` |
| riskNote | `risk.note_required` | `risk` of `medium` or `high` requires `riskNote` |
| risk | `risk.below_component_floor` | Risk must be at least the highest `minRisk` among the declared components. `minRisk` is optional per-component config |
| revertNote | `revert.note_required` | `revert-with-followup` and `forward-fix-only` require `revertNote` |
| revertWith | `revert.with_required` | `coordinated` requires a non-empty `revertWith` |
| components | `components.duplicate` | Components must be unique |
| base | `base.equals_head` | base must differ from head |
| refs.stackedOn | `refs.stacked_on_default_base` | `stackedOn` is not allowed when base is the default branch |

**Checks that need the network.** These run after zod. They are still reported as `INPUT_INVALID` issues unless noted otherwise.
- `components.undeclared_touched`: changed paths match a component's globs, but that component is not declared.
- `refs.stack_mismatch`: `refs.stackedOn` is not the open PR whose head is `base`.
- `refs.not_found`: a referenced PR or issue does not exist.
- Warning `COMPONENTS_UNUSED`: a declared component has no matching changed path.
- Warning `COMPONENTS_UNCHECKED`: more than 300 files changed and there is no local checkout to diff **[G-300]**.

### 2.2 Rendering

Controlled by config `render.mode`; the default is `trailer`.

```
{description}

Risk: {risk} · Components: {c1, c2} · Revert: {revertPolicy} · Tests: {P}/{N} pass ({kinds}){ · Stacked on #X}{ · Split from #Y}{ · Closes #Z…}

{footer: config render.footer, default "🤖 Generated with [Claude Code](https://claude.com/claude-code)"}

<!-- ghx:v1 {pr block} -->
```

- **Test summary.** `P` counts items with `result=pass` and `N` counts all items. Non-pass results are appended, e.g. `2/3 pass, 1 not-run`.
- **Visible refs.** `Closes #N` and stack refs go in the **visible** trailer, so GitHub's auto-close and human readers both work. In §4.1, 19 bodies said "Stacked on #…".
- **`details` mode.** Adds a collapsed `<details><summary>How to test</summary>` list of testing commands below the trailer, an option raised in §4.1.
- **Body size.** The rendered body is asserted to be at most 65,536 chars. The field caps make that limit unreachable.

### 2.3 Output

```ts
const PrCreateOutput = z.object({
  ref: PrRef, number: z.number(), url: z.string().url(),
  title: z.string(), base: z.string(), head: z.object({ ref: z.string(), sha: Sha }),
  draft: z.boolean(), draftDerived: z.boolean(),
  stackedOn: PrRef.nullable(), blockId: z.string(), body: z.string(),
  next: z.array(z.string()),                        // ["ghx ci wait owner/repo#N"]
  warnings: z.array(Warning),
});
// --dry-run: { dryRun: true, ...PrCreateOutput without ref/number/url }
```

### 2.4 Extras

- **Draft is derived.** When `draft` is omitted, the PR is a draft if base is not the default branch. An explicit `draft:false` on a stacked base is honoured, with the warning `STACKED_NOT_DRAFT`. This follows the user's rule "base main as ready, or as a draft stacked on its base slice" (§4.1, §9.4).
- **Stack auto-detect.** If base is not the default branch, ghx looks up the open PR whose head is `base` and fills `refs.stackedOn`. If there is none, it warns `BASE_NOT_A_PR`.
- **Duplicates.** If an open PR already exists for `head`, ghx refuses with `DUPLICATE_PR`, names the existing ref, and hints at `ghx pr edit`. A closed PR for the same head only triggers a warning (§9.4).
- **Batch (`--batch`).** This is the safe form of the 8-PR shell function in §4.1, which produced a PR literally titled `$2`.

```ts
const PrBatchInput = z.object({
  defaults: PrCreateInput.innerType().partial().omit({ title: true, head: true }).optional(),
  items: z.array(PrCreateInput.innerType().partial()).min(1).max(20),
}).strict();
// item_i = deepMerge(defaults, item) (arrays replace) → validated as PrCreateInput; issue paths prefixed "items[i]."
```

  - Heads must be unique across the batch.
  - Items whose `base` is another item's `head` are ordered topologically; a cycle is an `INPUT_INVALID` issue. Such items default to draft, and their `stackedOn` is filled in once the parent PR exists.
  - **Every item is validated, including the network preflight, before the first POST.** Creation stops at the first failure.
  - Output: `{created: PrCreateOutput[], failed: {index, head, error} | null, notAttempted: {index, head}[]}`. Exit 0 if every item succeeds. Otherwise the exit code is the failing item's error class, and the code is `PARTIAL_FAILURE` if at least one PR was created.
  - A shared rationale such as "Split out of #3167" becomes `defaults.refs.splitFrom`.

### 2.5 Errors

- `INPUT_MISSING`, `INPUT_NOT_JSON`, `INPUT_INVALID` (exit 3)
- `CONFIG_MISSING`, `CONFIG_INVALID` (4)
- `DUPLICATE_PR` (5)
- `BRANCH_MISSING`, `HEAD_NOT_PUSHED`, `NO_COMMITS` (6)
- `REPO_NOT_FOUND` (7)
- `GH_FORBIDDEN`, `GH_API_ERROR`, `PARTIAL_FAILURE` (8)

Examples are in §6.2.

### 2.6 gh calls

1. Load config for the target repo: the local file if the cwd is that repo, otherwise the contents API at `base` (01 decides) **[G-CWD]**.
2. Run zod validation, with no network. Fail fast and report all issues.
3. One `gh api graphql` query:
   - `viewer{login}`
   - `repository{defaultBranchRef{name}, viewerPermission}`
   - `baseRef: ref(qualifiedName:"refs/heads/<base>"){target{oid}}` and `headRef: ref(...){target{oid}}`
   - `open: pullRequests(headRefName:<head>, states:OPEN){number}`
   - `closed: pullRequests(headRefName:<head>, states:[CLOSED,MERGED], last:1){number}`
   - `parent: pullRequests(headRefName:<base>, states:OPEN, first:2){number}`
   - aliases that resolve every PrRef in `refs`
4. `gh api repos/o/r/compare/<base>...<head>` for `ahead_by` and `files`. If it returns 300 files, use local `git diff --name-only origin/<base>...origin/<head>` when the cwd matches; otherwise skip and warn **[G-300]**.
5. When the cwd matches, compare local `git rev-parse <head>` with the remote oid. If they differ, warn `HEAD_DIFFERS_FROM_LOCAL` with a hint to `git push` (§5.4).
6. Render the body. `--dry-run` stops here.
7. `gh api -X POST repos/o/r/pulls --input -` with `{title, body, base, head, draft}`.
   - Not `gh pr create`, which can prompt, apply templates or push. JSON on stdin also avoids quoting problems (§4.1).
   - A 422 "already exists" (a race) becomes `DUPLICATE_PR`.
   - After a transient failure, re-run step 3's open-PR query before retrying, because a POST is not idempotent.
8. Read back with `gh api repos/o/r/pulls/N` and assert that the stored title and body equal what was rendered. This catches the title drift seen in §4.1.

---

## 3. `pr edit`

```
ghx pr edit <pr> [--input patch.json|-] [--discard-ui-edits] [--dry-run]
```

Purpose: patch the structured object of an existing PR (re-validated and re-rendered), retarget its base, or toggle draft.

```ts
const PrEditInput = PrCreateInput.innerType().omit({ head: true }).partial()
  .extend({ adopt: z.boolean().optional() })        // adopt an unstructured PR: requires all create fields but head
  .strict()
  .refine(p => Object.keys(p).length > 0, "empty patch");
```

Rules:
- **Merge.** The merged object is `{...currentBlock, ...patch}`; arrays are replaced, not merged. It is validated against the **full** `createRules` plus the network checks: the base must exist, and the stack is recomputed when `base` changes. `rev` increments.
- **No block.** If the PR has no valid, trusted `pr` block, ghx refuses with `NO_BLOCK` unless the patch has `adopt: true` and every required field.
- **Drift.** If the visible description differs from `block.description` (someone edited it in the UI) and the patch omits `description`, ghx refuses with `DESCRIPTION_DRIFT`. The hint quotes the visible text and offers `--discard-ui-edits`.
- **Concurrency.** Immediately before the PATCH, ghx re-reads `updatedAt` and a hash of the body. If either changed, it refuses with `CONCURRENT_EDIT`.
- **Draft toggle.** `draft:false` replaces `gh pr ready`, which was called 12 times (§2.1).
- **Base retarget.** Changing `base` replaces `gh pr edit --base`: 2 calls, one of which was denied by the classifier (§3.2). If the PR has children, ghx warns `HAS_CHILDREN`.

Output: `{ref, rev, changed: ("title"|"body"|"base"|"draft")[], body, warnings}`.

Errors: `INPUT_INVALID` (3); `NO_BLOCK`, `DESCRIPTION_DRIFT`, `CONCURRENT_EDIT`, `PR_NOT_OPEN`, `BRANCH_MISSING` (6); `PR_NOT_FOUND` (7); `GH_API_ERROR` (8).

gh calls:
1. A GraphQL PR snapshot: body, title, base, isDraft, updatedAt and author association.
2. Parse the block.
3. Validate the merged object.
4. If `base` changed, run the network checks from `pr create` step 3.
5. Re-read `updatedAt`.
6. `gh api -X PATCH repos/o/r/pulls/N --input -` with `{title, body, base}`.
7. If `draft` changed, GraphQL `markPullRequestReadyForReview` or `convertPullRequestToDraft`. REST cannot change draft state.
8. Read back the PR.

---

## 4. `pr status`

```
ghx pr status <pr> [-R owner/repo] [--no-compare-main] [--no-wait-mergeable]
```

Purpose: one object that answers "what is this PR, can it land, and what's left to do?" (§8a, §9.3). It folds together the description, metadata, merge state, CI for the head SHA, all feedback, preconditions and stack.

### 4.1 Output

```ts
const PrMeta = z.object({                           // lenient read of the `pr` block (§9)
  id: z.string(), rev: z.number(), gen: z.string(),
  risk: Risk.or(z.string()), riskNote: z.string().nullable(),
  components: z.array(z.string()),
  revertPolicy: RevertPolicy.or(z.string()), revertNote: z.string().nullable(), revertWith: z.array(PrRef),
  testing: z.array(TestingItem.passthrough()),
  refs: Refs.passthrough(),
});
const Violation = z.object({ code: z.string(), message: z.string(), overridable: z.boolean(),
                             details: z.record(z.unknown()).optional() });
const StatusEvent = z.object({ id: z.string(), by: z.string(), at: Iso, commit: Sha.nullable(),
                               note: z.string().nullable(), verified: z.boolean().nullable(), url: z.string() });
const Finding = z.object({
  id: z.string(), reviewId: z.string(), severity: Severity.or(z.string()),
  path: z.string().nullable(), line: z.number().nullable(), endLine: z.number().nullable(),
  alsoAt: z.array(z.object({ path: z.string(), line: z.number() })),
  title: z.string(), body: z.string(), truncated: z.boolean(),
  inline: z.boolean(), commit: Sha, outdated: z.boolean(),   // outdated = GitHub thread isOutdated
  status: FindingStatus, statusEvent: StatusEvent.nullable(), url: z.string(),
});
const Review = z.object({
  id: z.string(), structured: z.boolean(), author: Author,
  verdict: Verdict.nullable(),                      // from ghx block; null for unstructured
  githubState: z.enum(["APPROVED","CHANGES_REQUESTED","COMMENTED","DISMISSED","PENDING"]),
  verdictDowngraded: z.boolean(),                   // ghx verdict couldn't be posted natively (self-review)
  submittedAt: Iso, commit: Sha, outdated: z.boolean(),      // outdated = commit ≠ head
  summary: z.string(), truncated: z.boolean(), findingIds: z.array(z.string()), url: z.string(),
});
const Comment = z.object({
  id: z.string(), source: z.enum(["issue","review","inline"]), author: Author, at: Iso,
  body: z.string(), truncated: z.boolean(), structured: z.boolean(),
  kind: z.enum(["note","precondition","status","supersede","resolve"]).nullable(),
  path: z.string().nullable(), line: z.number().nullable(),
  threadResolved: z.boolean().nullable(), inReplyTo: z.string().nullable(),
  edited: z.boolean(), blockError: z.string().nullable(), url: z.string(),
});
const BotItem = z.object({
  id: z.string(), source: z.enum(["issue","review","inline"]), author: z.string(), at: Iso,
  marker: z.string().nullable(), summary: z.string(),        // first heading/line, ≤ 200
  path: z.string().nullable(), line: z.number().nullable(), url: z.string(),
});
const Condition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pr-merged"), ref: PrRef }),
  z.object({ type: z.literal("release-includes"), ref: PrRef }),
  z.object({ type: z.literal("manual"), text: z.string() }),
]);
const Precondition = z.object({
  id: z.string(), condition: Condition, status: PreconditionStatus,
  evidence: z.string(), declaredBy: z.string(), declaredAt: Iso, url: z.string(),
  override: StatusEvent.extend({ status: PreconditionStatus }).nullable(),
});
const MergeState = z.object({
  mergeable: z.enum(["MERGEABLE","CONFLICTING","UNKNOWN"]), settled: z.boolean(),
  mergeStateStatus: z.enum(["BEHIND","BLOCKED","CLEAN","DIRTY","DRAFT","HAS_HOOKS","UNKNOWN","UNSTABLE"]),
  reviewDecision: z.enum(["APPROVED","CHANGES_REQUESTED","REVIEW_REQUIRED"]).nullable(),
  method: z.enum(["merge","squash","rebase"]),       // from config
  ready: z.boolean(),                                // == pr merge would proceed now
  blockers: z.array(Violation), waivers: z.array(Violation), warnings: z.array(Violation),
  mergedAt: Iso.nullable(), mergeCommit: Sha.nullable(),
});
const Stack = z.object({
  parent: z.object({ ref: PrRef, state: z.string(), draft: z.boolean(), headRef: z.string() }).nullable(),
  declaredParent: PrRef.nullable(),                  // meta.refs.stackedOn
  children: z.array(z.object({ ref: PrRef, state: z.string(), draft: z.boolean(), headRef: z.string() })),
  baseChanges: z.array(z.object({ from: z.string(), to: z.string(), at: Iso, automatic: z.boolean() })),
});
const PrStatusOutput = z.object({
  ref: PrRef, url: z.string(), number: z.number(), title: z.string(), author: Author,
  state: z.enum(["OPEN","CLOSED","MERGED"]), draft: z.boolean(), createdAt: Iso, updatedAt: Iso,
  base: z.object({ ref: z.string(), isDefault: z.boolean() }),
  head: z.object({ ref: z.string(), sha: Sha }),
  changes: z.object({ files: z.number(), additions: z.number(), deletions: z.number(), commits: z.number() }),
  description: z.object({ text: z.string(), structured: z.boolean(),
                          drift: z.array(z.enum(["title","description","trailer"])) }),
  meta: PrMeta.nullable(), metaError: z.object({ code: z.string(), message: z.string() }).nullable(),
  merge: MergeState,
  ci: CiSummary,
  feedback: z.object({
    reviews: z.array(Review), findings: z.array(Finding), comments: z.array(Comment), bots: z.array(BotItem),
    counts: z.object({ reviews: z.number(), findingsTotal: z.number(), findingsOpen: z.number(),
                       comments: z.number(), bots: z.number(), unresolvedHumanThreads: z.number(),
                       omitted: z.number() }),
  }),
  openFindings: z.array(z.string()),                 // ids, severity-sorted (high first)
  preconditions: z.array(Precondition),
  stack: Stack,
  warnings: z.array(Warning), fetchedAt: Iso,
});
```

Folding rules:
- **Each GitHub item appears exactly once**, in one of four lists:
  - `reviews`: review bodies.
  - `findings`: finding blocks, whether inline or in a review body.
  - `comments`: everything else from humans or ghx, including resolve events.
  - `bots`: bot items.
- **Description.** `description.text` is the **visible** prose: the body minus the trailer, footer and block. `meta` comes from the block. If the block's description or title differs from what is visible, `drift` lists the fields that differ.
- **Unstructured items are kept.** PRs, comments and reviews without a valid, trusted block get `structured: false` and are never dropped (brief 7). If a block was present but rejected (invalid, untrusted, or a newer major version), the comment carries `blockError`.
- **Bots.** An item goes to `bots[]` if any of these hold:
  - the author's `__typename` is `Bot`, or the login ends in `[bot]`;
  - the login is in `config.bots.logins`;
  - the body starts with a marker in `config.bots.markers`, e.g. `<!-- ci-duration-watch -->` (§8c4).

  Bot inline suggestions such as Copilot's keep their path and line (§8c3).
- **Merge fields.** `merge.blockers`, `waivers` and `warnings` come from **the same policy engine** as `pr merge` (§8). That makes `ready` the direct answer to the top question in §8a.
- **Truncation.** Limits: `description.text` 1,000 chars, comment body 500, finding body 600, review summary 400. If the total is still over 32 KB, ghx drops the bodies of resolved findings first, then the oldest comments. It increments `counts.omitted` and adds a hint pointing to `pr feedback`.

### 4.2 Errors

- `PR_NOT_FOUND`, `REPO_NOT_FOUND` (7).
- `CONFIG_MISSING`/`CONFIG_INVALID` (4). `pr status` still works without config: components, noise filtering and policy degrade, with the warning `CONFIG_MISSING`, and `merge.ready` is false with the blocker `CONFIG_MISSING`.
- `GH_*` (8).

### 4.3 gh calls

1. Resolve the repo **[G-CWD]**.
2. GraphQL Q1, a single query with these parts:
   - **PR fields:** `number title body state isDraft author{login __typename} authorAssociation createdAt updatedAt baseRefName headRefName headRefOid mergeable mergeStateStatus reviewDecision changedFiles additions deletions commits{totalCount} mergedAt mergeCommit{oid}`.
   - **Issue comments:** `comments(first:100){databaseId author authorAssociation body createdAt lastEditedAt url}`.
   - **Reviews:** `reviews(first:100){databaseId author authorAssociation state body submittedAt commit{oid} url}`.
   - **Inline threads:** `reviewThreads(first:100){id isResolved isOutdated path line comments(first:50){databaseId author authorAssociation body createdAt replyTo{databaseId} pullRequestReview{databaseId} url}}`.
   - **Base changes:** `timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT], last:20)` **[G-RETARGET]**. Agents dug through the timeline by hand twice (§2.4).
   - **CI rollup:** `commits(last:1){commit{oid statusCheckRollup{contexts(first:100){… on CheckRun{databaseId name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:N) checkSuite{workflowRun{databaseId runNumber workflow{databaseId name}}}} … on StatusContext{context state targetUrl isRequired(pullRequestNumber:N)}}}}}`.
   - **Viewer and repo:** `viewer{login}` and `repository{defaultBranchRef{name} mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed}`.
   - Any connection with `hasNextPage` is paginated.
3. **[G-SHA]** Assert that the rollup's `commit.oid` equals `headRefOid`. On a mismatch, re-query once. If it persists, warn `CI_SHA_MISMATCH` and report `ci.state = pending`.
4. **[G-UNKNOWN]** Unless `--no-wait-mergeable` is set, retry while `mergeable` is `UNKNOWN`. Re-query `{mergeable mergeStateStatus headRefOid}` with backoff of 1, 2, 3, 4, 5 and 5 s, at most 20 s in total. Asking for the field is what triggers GitHub's background computation. If it is still unknown, set `settled:false` and warn. If the head changed meanwhile, restart from step 2, once.
5. GraphQL Q2, using aliases:
   - `parent: pullRequests(headRefName:<base>, states:[OPEN,MERGED], first:2)`
   - `children: pullRequests(baseRefName:<head>, states:OPEN, first:20)`
   - each precondition `ref` as `p<N>: pullRequest(number:N){state mergeCommit{oid}}`
   - each `addressed` event commit, verified with REST `compare/<commit>...<headSha>`; a status of `ahead` or `identical` means reachable. At most 10; beyond that, `verified:null`.
6. Build the expected-check set and ETA (§11.3, §11.6) from cached baselines.
7. If any Actions checks are failing and `--no-compare-main` is not set, run the shared-with-main engine (§1.5) using the `ci why` machinery:
   - per failing job: `actions/jobs/{id}` and `actions/jobs/{id}/logs` **[G-LOGS]**;
   - per failing workflow: `actions/workflows/{wf}/runs?branch=<default>&status=completed&event=push&per_page=5`, then `actions/runs/{id}/jobs`, then the matching job's logs.
   - At most 5 failing jobs. Beyond that, `sameOnMain:null` and the merge blocker stays `CI_RED`.
8. For `release-includes` preconditions: `releases/latest`, then `compare/<tag>...<mergeCommit>`.

A typical green PR costs 2 GraphQL calls plus cached baselines. A red one adds about 3 REST calls per failing job. That replaces the 5–8 call chain in §8b.

---

## 5. `pr feedback`

```
ghx pr feedback <pr> [--open] [--source ghx|human|bot] [--since <iso|sha>] [--include-outdated]
```

Purpose: the full feedback picture from all three sources (§8b), with full bodies.

- **`--open`** keeps only open findings, unresolved human threads, unmet preconditions, and each reviewer's latest non-dismissed `CHANGES_REQUESTED` review.
- **`--since <sha>`** keeps items created after that commit's committer date, i.e. "what came in since my last push".
- **`--include-outdated`** keeps findings and threads that GitHub marks outdated. They are excluded by default only under `--open`.

Output: `{ref, headSha, feedback: <PrStatusOutput.feedback with bodies ≤ 8,000 chars>, openFindings, preconditions, artifactPath: string | null, warnings}`. Bodies longer than 8,000 chars are written in full to `artifactPath` (one JSON file) and truncated inline.

Errors: same as `pr status`. gh calls: Q1 without the rollup, then step 5 (preconditions and verification).

---

## 6. Exit codes and error catalogue

### 6.1 Exit-code table

| Exit | Class | Meaning | Agent action |
|---:|---|---|---|
| 0 | OK | Success. A read succeeds even when the answer is "red" | — |
| 1 | INTERNAL | A ghx bug or unexpected exception | Report it |
| 2 | USAGE | Unknown command or flag, bad selector, or a redirect to a wrapped command | Fix the invocation; the hint gives the exact one |
| 3 | INPUT | Input JSON missing, unparseable or invalid. All issues are listed | Fix the input |
| 4 | CONFIG | Repo config missing or invalid | Fix `.ghx.json` |
| 5 | POLICY | A ghx rule refused a write. Overridable codes are listed | Ask the user, or pass `--override CODE --reason` |
| 6 | STATE | GitHub's current state forbids it: head moved, conflict, CI pending, branch missing, concurrent edit | Change the state (push, rebase, wait), then retry |
| 7 | NOT_FOUND | PR, repo, run, id or ref not found, including a cwd/repo mismatch | Fix the selector or `--repo` |
| 8 | GITHUB | gh missing, auth, permission, rate limit, API failure after retries, partial batch | Retry later, or fix auth |
| 10 | CI red | `ci wait`: a considered check failed and the merge gate does not waive it | Read the folded diagnosis; fix it or `ci rerun` |
| 11 | CI red, shared | `ci wait`, in every until-mode: red, but every failure is shared with main (§1.5). It is separate because the user's rule makes this mergeable (§4.3) | Proceed to `pr merge`; the waiver applies |
| 12 | Timeout | `ci wait`: the budget ran out with checks still pending, or `--if-eta-under` was exceeded | Run it in the background with `--max` |
| 13 | Superseded | `ci wait`: the head moved (with `--on-head-change stop`), or the PR was closed or merged mid-wait | Re-read the state |
| 14 | No checks | `ci wait`: nothing registered within the grace period. This is not "green": treating it as green is the misread behind the 11 cases in §3.1 | Check the triggers; try `ci retrigger` |
| 130/143 | Interrupted | SIGINT or SIGTERM. `ci wait` still emits a best-effort `result` with `outcome: "interrupted"` | — |

When `ci wait` watches several targets, the overall exit code uses this precedence: `10 red` > `14 no-checks` > `13 superseded` > `12 timeout` > `11 red-shared` > `0 green`.

### 6.2 Error catalogue (one example per code)

| Code | Exit | Example |
|---|---:|---|
| `UNKNOWN_COMMAND` | 2 | `{"error":{"code":"UNKNOWN_COMMAND","message":"'ghx pr frob' is neither a ghx command nor an allowlisted gh read.","hint":"Run 'ghx --schema' to list commands.","details":{"argv":["pr","frob"]}}}` |
| `UNKNOWN_FLAG` | 2 | `{"error":{"code":"UNKNOWN_FLAG","message":"'ghx pr status' has no flag '--json'.","hint":"Output is a fixed schema; run 'ghx pr status --schema' to see its fields.","details":{"flag":"--json"}}}` |
| `BAD_SELECTOR` | 2 | `{"error":{"code":"BAD_SELECTOR","message":"'pr-3198' is not a PR selector.","hint":"Use 3198, #3198, powerhouse-inc/powerhouse#3198 or a PR URL.","details":{}}}` |
| `USE_WRAPPED_COMMAND` | 2 | `{"error":{"code":"USE_WRAPPED_COMMAND","message":"'gh pr view' is replaced by 'ghx pr status'.","hint":"ghx pr status 3198 -R powerhouse-inc/powerhouse","details":{"replacement":["ghx","pr","status","3198","-R","powerhouse-inc/powerhouse"]}}}` |
| `INPUT_MISSING` | 3 | `{"error":{"code":"INPUT_MISSING","message":"No JSON input: stdin is a terminal and --input was not given.","hint":"Pass --input pr.json, or pipe the JSON on stdin.","details":{}}}` |
| `INPUT_NOT_JSON` | 3 | `{"error":{"code":"INPUT_NOT_JSON","message":"Input is not valid JSON: Unexpected token } at 412.","hint":"Write the object to a file and pass --input <file>; do not build JSON with shell interpolation.","details":{"offset":412}}}` |
| `INPUT_INVALID` | 3 | `{"error":{"code":"INPUT_INVALID","message":"3 input issues.","hint":"title is 81 chars (max 72): shorten the subject; move detail into description.","details":{"issues":[{"path":"title","code":"title.too_long","message":"81 > 72"},{"path":"description","code":"description.markdown_structure","message":"line 2 starts with '- '"},{"path":"testing[0]","code":"testing.compound_command","message":"unquoted '|' in command; use cwd and record the plain command"}]}}}` |
| `CONFIG_MISSING` | 4 | `{"error":{"code":"CONFIG_MISSING","message":"powerhouse-inc/powerhouse has no .ghx.json at main.","hint":"Add .ghx.json with at least {\"components\":[…]}; run 'ghx config --schema' for the format.","details":{"repo":"powerhouse-inc/powerhouse"}}}` |
| `CONFIG_INVALID` | 4 | `{"error":{"code":"CONFIG_INVALID","message":".ghx.json: merge.method 'squash-only' is not one of merge|squash|rebase.","hint":"Fix .ghx.json at merge.method.","details":{"issues":[{"path":"merge.method","message":"invalid enum"}]}}}` |
| `DUPLICATE_PR` | 5 | `{"error":{"code":"DUPLICATE_PR","message":"fix/reactor-bind-document-id already has open PR powerhouse-inc/powerhouse#3301.","hint":"Update it instead: ghx pr edit powerhouse-inc/powerhouse#3301 --input patch.json","details":{"existing":"powerhouse-inc/powerhouse#3301"}}}` |
| `MERGE_BLOCKED` | 5/6 | See §8.4 |
| `AUTHOR_NOT_VIEWER` | 5 | `{"error":{"code":"AUTHOR_NOT_VIEWER","message":"#3169 is authored by other-dev, not you (thegoldenmule).","hint":"Only act on your own PRs; if the user asked for this one, add --override AUTHOR_NOT_VIEWER --reason \"<who asked>\".","details":{"author":"other-dev"}}}`. Used by `ci retrigger`; for merges it appears inside `MERGE_BLOCKED` |
| `RERUN_LIMIT` | 5 | `{"error":{"code":"RERUN_LIMIT","message":"Run 37951014406 is on attempt 3 (limit 3).","hint":"Diagnose instead: ghx ci why powerhouse-inc/powerhouse#3187. Override with --override RERUN_LIMIT --reason only if the user approved.","details":{"runId":37951014406,"attempt":3}}}` |
| `PASSTHROUGH_WRITE_REFUSED` | 5 | `{"error":{"code":"PASSTHROUGH_WRITE_REFUSED","message":"'gh issue create' mutates GitHub and is not wrapped by ghx.","hint":"ghx only performs validated writes. If the user approved this, run gh directly.","details":{"argv":["issue","create"]}}}` |
| `HEAD_MOVED` | 6 | `{"error":{"code":"HEAD_MOVED","message":"Head is 9f2c4e1, expected 4b1e7d2.","hint":"Re-check the new head: ghx pr status powerhouse-inc/powerhouse#3301, then retry with --expect-head 9f2c4e1.","details":{"expected":"4b1e7d2…","actual":"9f2c4e1…"}}}` |
| `PR_NOT_OPEN` | 6 | `{"error":{"code":"PR_NOT_OPEN","message":"#3211 is CLOSED.","hint":"Reopen it in the UI or create a new PR.","details":{"state":"CLOSED"}}}` |
| `BRANCH_MISSING` | 6 | `{"error":{"code":"BRANCH_MISSING","message":"Base branch 'feat/reactor-worker' does not exist on powerhouse-inc/powerhouse.","hint":"Check the name, or create and push the base first.","details":{"branch":"feat/reactor-worker"}}}` |
| `HEAD_NOT_PUSHED` | 6 | `{"error":{"code":"HEAD_NOT_PUSHED","message":"Branch 'fix/x' is not on the remote.","hint":"git push -u origin fix/x","details":{"branch":"fix/x"}}}` |
| `NO_COMMITS` | 6 | `{"error":{"code":"NO_COMMITS","message":"fix/x has no commits ahead of main.","hint":"Commit and push your change first.","details":{"aheadBy":0}}}` |
| `NO_BLOCK` | 6 | `{"error":{"code":"NO_BLOCK","message":"#3088 has no ghx metadata block.","hint":"Adopt it: pass the full object with \"adopt\": true.","details":{}}}` |
| `DESCRIPTION_DRIFT` | 6 | `{"error":{"code":"DESCRIPTION_DRIFT","message":"The visible description was edited outside ghx.","hint":"Include \"description\" in the patch (current visible text is in details), or pass --discard-ui-edits.","details":{"visible":"…"}}}` |
| `CONCURRENT_EDIT` | 6 | `{"error":{"code":"CONCURRENT_EDIT","message":"#3301 changed since it was read (updatedAt 16:30:40 → 16:31:02).","hint":"Re-run the same command; it re-reads the PR.","details":{}}}` |
| `RUN_IN_PROGRESS` | 6 | `{"error":{"code":"RUN_IN_PROGRESS","message":"All failed runs for 9f2c4e1 are still running; GitHub rejects reruns until a run completes.","hint":"ghx ci wait powerhouse-inc/powerhouse#3301 --until settled, then ghx ci rerun.","details":{"runs":[37948190914]}}}` |
| `NO_FAILED_RUNS` | 6 | `{"error":{"code":"NO_FAILED_RUNS","message":"No failed Actions runs for head 9f2c4e1.","hint":"Nothing to rerun. If CI never started after a base change, use ghx ci retrigger.","details":{"ciState":"green"}}}` |
| `HEAD_BRANCH_MISSING` | 6 | `{"error":{"code":"HEAD_BRANCH_MISSING","message":"Head branch 'fix/x' was deleted; closing the PR could not be undone.","hint":"Push the branch again before retriggering.","details":{}}}` |
| `PR_NOT_FOUND` | 7 | `{"error":{"code":"PR_NOT_FOUND","message":"No PR #3258 in thegoldenmule/sektar (repo resolved from cwd).","hint":"Pass the repo: ghx pr status powerhouse-inc/powerhouse#3258 (or -R owner/repo).","details":{"repo":"thegoldenmule/sektar","repoSource":"cwd"}}}` |
| `REPO_NOT_FOUND` | 7 | `{"error":{"code":"REPO_NOT_FOUND","message":"Could not determine a repo: cwd is not a git checkout.","hint":"Pass -R owner/repo or an owner/repo#N selector.","details":{}}}` |
| `RUN_NOT_FOUND` | 7 | `{"error":{"code":"RUN_NOT_FOUND","message":"Run 123 not found in powerhouse-inc/powerhouse.","hint":"Check the id, or use the PR: ghx ci why <pr>.","details":{}}}` |
| `ID_NOT_FOUND` | 7 | `{"error":{"code":"ID_NOT_FOUND","message":"No finding or precondition f_zzzzzz on #3301.","hint":"List ids: ghx pr feedback powerhouse-inc/powerhouse#3301 --open","details":{"known":["f_h4x8pz","f_n2c6rv"]}}}` |
| `REF_NOT_FOUND` | 7 | `{"error":{"code":"REF_NOT_FOUND","message":"Precondition ref #9999 does not exist.","hint":"Use an existing PR ref (owner/repo#N for cross-repo).","details":{}}}` |
| `GH_NOT_INSTALLED` | 8 | `{"error":{"code":"GH_NOT_INSTALLED","message":"gh not found on PATH.","hint":"Install GitHub CLI ≥ 2.60 and run 'gh auth login'.","details":{}}}` |
| `GH_AUTH` | 8 | `{"error":{"code":"GH_AUTH","message":"gh is not authenticated for github.com.","hint":"Run 'gh auth login' (a human must do this).","details":{}}}` |
| `GH_FORBIDDEN` | 8 | `{"error":{"code":"GH_FORBIDDEN","message":"You lack push permission on powerhouse-inc/powerhouse (viewerPermission READ).","hint":"Use a fork head (owner:branch) or ask for access.","details":{}}}` |
| `GH_RATE_LIMITED` | 8 | `{"error":{"code":"GH_RATE_LIMITED","message":"GraphQL rate limit exhausted; resets 09:47:00Z.","hint":"Retry after the reset; ci wait backs off automatically.","details":{"resetAt":"…"}}}` |
| `GH_API_ERROR` | 8 | `{"error":{"code":"GH_API_ERROR","message":"POST /pulls failed after 3 attempts: HTTP 502.","hint":"Retry; ghx re-checks for a created PR before re-posting.","details":{"status":502}}}` |
| `GH_PASSTHROUGH_FAILED` | 8 | `{"error":{"code":"GH_PASSTHROUGH_FAILED","message":"gh issue view 2894 exited 1.","hint":"See details.stderr.","details":{"exitCode":1,"stderr":"…"}}}` |
| `DIFF_TOO_LARGE` | 8 | `{"error":{"code":"DIFF_TOO_LARGE","message":"GitHub refuses diffs over 300 files (HTTP 406).","hint":"git fetch origin && git diff --stat origin/main...origin/<head>","details":{}}}` |
| `REOPEN_FAILED` | 8 | `{"error":{"code":"REOPEN_FAILED","message":"#3187 was closed to retrigger CI but reopening failed 3 times.","hint":"Reopen now: gh api -X PATCH repos/powerhouse-inc/powerhouse/pulls/3187 -f state=open","details":{"closedAt":"…"}}}` |
| `REVIEW_REJECTED` | 8 | `{"error":{"code":"REVIEW_REJECTED","message":"GitHub rejected the review: 'Line could not be resolved' (finding 2).","hint":"Re-run; ghx recomputes diff hunks against the current head.","details":{"findingIndex":1}}}` |
| `PARTIAL_FAILURE` | 8 | `{"error":{"code":"PARTIAL_FAILURE","message":"Batch created 3 of 8 PRs; item 3 failed with HEAD_NOT_PUSHED.","hint":"Push fix/y and re-run the batch with items 3–7 only.","details":{"created":["…#3171","…#3172","…#3173"],"failed":{"index":3},"notAttempted":[4,5,6,7]}}}` |
| `INTERNAL` | 1 | `{"error":{"code":"INTERNAL","message":"Unexpected: …","hint":"Report this with details.trace.","details":{"trace":"…"}}}` |

Merge-specific violation codes (§8.2) appear inside `MERGE_BLOCKED.details.plan.blockers`.

---

## 7. Feedback writes: `pr comment`, `pr review`, `pr resolve`

### 7.1 `pr comment`

```
ghx pr comment <pr> [--input c.json|-] [--close] [--dry-run]
```

Purpose: post a typed coordination comment. A precondition is enforced by `pr merge` (§8c5). `--close` closes the PR after posting, which covers the 4 `pr close --comment` calls in §7.

```ts
const Body = (maxChars: number, maxLines: number) => z.string().trim().min(1).max(maxChars)
  .refine(s => s.split("\n").length <= maxLines).refine(s => !s.includes("<!-- ghx:"));
const PrCommentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), body: Body(1500, 15) }).strict(),          // e.g. slice summary (§8d #3168)
  z.object({ kind: z.literal("precondition"), condition: Condition, body: Body(500, 3).optional() }).strict(),
  z.object({ kind: z.literal("status"),
             state: z.enum(["waiting","blocked","ready","rebased","split"]),
             body: Body(500, 3), refs: z.array(PrRef).max(10).optional() }).strict(),
  z.object({ kind: z.literal("supersede"), by: PrRef, body: Body(500, 3).optional() }).strict(),
]);
```

Rules:
- Every `ref` must exist and must not be this PR.
- `--close` together with `precondition` is refused.
- `supersede` without `--close` warns `SUPERSEDED_STILL_OPEN`.
- A `manual` precondition evaluates to `unknown`. It blocks merges until resolved with `pr resolve <c_id> --status met --note …`.

Visible rendering (the block is appended after it):
- precondition: "**Merge precondition:** merge only after #3184 is merged." or "…after a release includes #3184."
- supersede: "Superseded by #3250."
- status: "**Status:** rebased. {body}"

Output: `{ref, id, kind, commentId, url, closed: boolean, precondition: {status, evidence} | null, warnings}`.

Errors: `INPUT_INVALID` (3), `PR_NOT_OPEN` (6), `PR_NOT_FOUND` and `REF_NOT_FOUND` (7), `GH_*` (8).

gh calls:
1. GraphQL: the PR's state, plus aliases for the refs.
2. `POST repos/o/r/issues/N/comments`.
3. If `--close`: `PATCH repos/o/r/pulls/N {state:"closed"}`.

### 7.2 `pr review`

```
ghx pr review <pr> [--input review.json|-] [--expect-head <sha>] [--dry-run]
```

Purpose: post a real GitHub review with a verdict and inline findings, each carrying a hidden block. Today agents used `gh pr review` 0 times, and verdicts were lost (§8d).

```ts
const Location = z.object({ path: RepoPath, line: z.number().int().positive() });
const FindingInput = z.object({
  severity: Severity, path: RepoPath, line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  side: z.enum(["RIGHT","LEFT"]).default("RIGHT"),
  alsoAt: z.array(Location).max(10).default([]),
  title: OneLine(100), body: Body(2000, 30),
  suggestion: z.string().max(2000).optional(),      // rendered as ```suggestion when inline
}).strict();
const PrReviewInput = z.object({
  verdict: Verdict, summary: Body(400, 3), scope: OneLine(200).optional(),
  findings: z.array(FindingInput).max(50).default([]),
}).strict().superRefine(reviewRules);
```

`reviewRules`:
- `review.approve_with_high`: an `approve` with any high finding is refused.
- `review.request_changes_without_findings`: `request-changes` needs at least one finding.
- `finding.range`: `endLine` must be at least `line`.
- `finding.duplicate`: (path, line, title) must be unique.
- `finding.path_not_in_pr` (network): the path must be one of the PR's files.

**Inline placement.**
- A finding is posted inline only if its line range lies inside a diff hunk on that side at the pinned commit. Hunks come from the `pulls/N/files` patches.
- Otherwise the finding goes into the review body, with its own `finding` block, and ghx warns `FINDING_NOT_INLINE`. One bad line would make GitHub reject the whole review.
- Files whose `patch` is omitted because they are too large are always body-only.

**Self-review.** If the viewer is the author, GitHub rejects APPROVE and REQUEST_CHANGES with a 422. ghx then posts the event as `COMMENT`, keeps the verdict in the block, sets `verdictDowngraded: true` and warns `VERDICT_DOWNGRADED`. This is the common case, because agents run under the user's token and review the user's PRs (§7; see Pushback).

**Pinning.** `commit_id` is `--expect-head` or the current head. If `--expect-head` doesn't match the head, the command fails with `HEAD_MOVED`, because a review against a stale head lands on the wrong lines **[G-SHA]**.

Rendering of the review body:
```
**ghx review** · {verdict} · {n} findings ({h} high, {m} medium, {l} low)

{summary}

Scope: {scope}

1. **[high]** `{path}:{line}` {title}
2. **[low]** `{path}:{line}` {title}

<!-- ghx:v1 {review block} -->
{<!-- ghx:v1 {finding block} --> for each body-only finding}
```

Rendering of each inline comment:
```
**[{severity}] {title}**

{body}

Also at: `{path}:{line}`, …

<!-- ghx:v1 {finding block} -->
```

Output: `{ref, id, githubReviewId, url, verdict, postedAs: "APPROVE"|"REQUEST_CHANGES"|"COMMENT", verdictDowngraded, commit, findings: [{id, severity, inline, commentId: number|null, url}], warnings}`.

Errors: `INPUT_INVALID` (3); `HEAD_MOVED`, `PR_NOT_OPEN` (6); `PR_NOT_FOUND` (7); `REVIEW_REJECTED`, `GH_*` (8).

gh calls:
1. GraphQL: head oid, author, viewer and state.
2. `GET repos/o/r/pulls/N/files?per_page=100`, paginated up to 3,000 files. Parse the hunks.
3. `POST repos/o/r/pulls/N/reviews --input -` with `{commit_id, event, body, comments:[{path, line, start_line?, side, start_side?, body}]}`, as one atomic call. There is no automatic retry with relocated findings: writes never fall back silently, so a 422 becomes `REVIEW_REJECTED`.
4. `GET repos/o/r/pulls/N/reviews/{id}/comments`, then map comment ids to finding ids by block id.

### 7.3 `pr resolve`

```
ghx pr resolve <pr> <id> [<id>…] --status addressed|wontfix|deferred|open|met|withdrawn|unmet
               [--commit <sha>] [--note "<≤200 chars, one line>"] [--tracking <issue-ref>] [--dry-run]
```

Purpose: change the status of findings or preconditions by appending a status event (§9.4 explains why events are used rather than edits). This implements the `feedback resolve <id> --commit <sha>` idea from §9.6. `--note` is the one prose flag. It is allowed because it is a single line of at most 200 chars and is not markdown.

| Rule | Failure |
|---|---|
| Every id exists on the PR and is trusted | `ID_NOT_FOUND` (7) |
| Finding ids take `addressed`, `wontfix`, `deferred` or `open`. Precondition ids take `met`, `withdrawn` or `unmet` | `INPUT_INVALID` |
| `addressed` requires `--commit`. The commit is resolved to a full SHA and must be reachable from head (`compare/<commit>...<head>` returns `ahead` or `identical`) and not reachable from base | issue `resolve.commit_not_in_pr` |
| `wontfix`, `deferred`, and the precondition statuses `met`/`withdrawn` require `--note` | issue `resolve.note_required` |
| A transition to the status the item already has | Warning `ALREADY_IN_STATUS`, exit 0, nothing posted |

Writes:
- **Inline findings:** a reply in the thread with `POST repos/o/r/pulls/N/comments/{commentId}/replies`, rendering "Addressed in 9f2c4e1." plus the block. Then, best-effort, GraphQL `resolveReviewThread(threadId)` for addressed, wontfix or deferred, or `unresolveReviewThread` for open. If that call fails, ghx only warns `THREAD_RESOLVE_FAILED`; the block is the source of truth.
- **Body-only findings and preconditions:** one issue comment that carries all of these targets.

Output: `{ref, events: [{id, from, to, commentId, url, threadResolved: boolean|null}], warnings}`.

---

## 8. `pr merge` (policy)

```
ghx pr merge <pr> [--expect-head <sha>] [--method merge|squash|rebase]
             [--override CODE[,CODE…] --reason "<≤200 chars>"] [--delete-branch] [--dry-run]
```

Purpose: merge only when policy allows, pinned to the head that was evaluated, and return the verified result. This replaces the 5-step sequence in §5.3. There is no prose input; everything is a flag. For squash merges, the commit title is `{PR title} (#N)` and the message is the description.

### 8.1 Flow and gh calls

1. Resolve the repo and load config. Config is required; if it is missing, the error is `CONFIG_MISSING` (4).
2. **Take a snapshot** using the `pr status` pipeline (§4.3 steps 2–8), with the `mergeable` retry bound raised to **30 s** **[G-UNKNOWN]**.
3. Pin `H` to the snapshot's `headRefOid`. If `--expect-head` is given and differs from `H`, the command fails with `HEAD_MOVED` **[G-SHA]**.
4. **Already merged.** If the PR is already merged and `--expect-head` is absent or matches, return `{merged:true, alreadyMerged:true}` with exit 0. Covers #3211 (§3.1).
5. Evaluate the checks (§8.2) and apply overrides:
   - An override code must be overridable and actually violated. An unknown code is `INPUT_INVALID`; an unused one warns `OVERRIDE_UNUSED`.
   - Any override requires `--reason`.
6. If this is a `--dry-run`, or there are blockers, output the plan (§8.4).
7. **Merge** with `gh api -X PUT repos/o/r/pulls/N/merge --input -` and `{sha: H, merge_method, commit_title?, commit_message?}`.
   - Why REST rather than `gh pr merge`:
     - `sha` pins the head server-side.
     - 405 (not mergeable) and 409 (head modified, which becomes `HEAD_MOVED`) are distinct responses.
     - It never touches local branches or worktrees. In §7, a `--delete-branch` failed because a worktree held the branch.
   - **On a 405**, re-read the PR to classify the failure: `DIRTY` becomes `MERGE_CONFLICT`, and `BLOCKED` becomes `BLOCKED_BY_PROTECTION` with GitHub's message.
   - **On a transient error** (5xx, or GraphQL "Something went wrong" as in #3214, §3.1), **re-read first**. If the PR now shows `merged: true` and its head oid still equals `H` (the head oid does not change on merge), report success with `recoveredFromTransient: true`. Otherwise retry once.
8. **Verify.** Poll `GET repos/o/r/pulls/N` until `merged:true`, for at most 10 s. This yields `merge_commit_sha` and `merged_at`, replacing step 5 of §5.3.
9. **Delete the branch** only if `--delete-branch` (or config `merge.deleteBranch`) is set, the head is in the same repo, and no open PR uses head as its base. Only the remote branch is deleted (`DELETE git/refs/heads/<head>`); otherwise ghx warns. GitHub then auto-retargets the children **[G-RETARGET]**.
10. Output, with `next: ["ghx ci wait branch:<default>@<mergeCommit>"]` (§11.7).

### 8.2 Checks

All checks are evaluated, and all violations are reported together.

| # | Code | Class | Overridable | Rule | Evidence |
|---|---|---|---|---|---|
| 1 | `PR_NOT_OPEN` | state | no | `state == OPEN` | |
| 2 | `PR_DRAFT` | state | no | Not a draft. Hint: `ghx pr edit <ref>` with `{"draft":false}` | |
| 3 | `HEAD_MOVED` | state | no | `--expect-head` matches `H` | §4.3 |
| 4 | `AUTHOR_NOT_VIEWER` | policy | yes | The author is the viewer (config `merge.requireOwnPr`, default true) | §4.3, only own PRs |
| 5 | `METHOD_NOT_ALLOWED` | policy | no (needs config) | The method is `config.merge.method`, default `merge`. `squash` or `rebase` needs `--method`, **and** an entry in `config.merge.allowedMethods`, **and** the method enabled on the repo | §4.3, §7: 4 unwanted squashes |
| 6 | `MERGEABLE_UNKNOWN` | state | no | Still UNKNOWN after 30 s | §5.2: 20 of 52 merges read UNKNOWN |
| 7 | `MERGE_CONFLICT` | state | no | `mergeable == CONFLICTING`. Hint: the exact `git fetch origin <base> && git merge origin/<base>` to run in the head worktree, then push | §3.3 #3198 |
| 8 | `BEHIND_BASE` | state | no | `mergeStateStatus == BEHIND` | |
| 9 | `BLOCKED_BY_PROTECTION` | state | no | `BLOCKED` for reasons not covered here (required reviews, rulesets) | |
| 10a | `CI_PENDING` | state | no | Considered checks for `H` are pending, or a required or config-expected check is missing (§11.3). Hint: `ghx ci wait <ref> --until mergeable` | §5.2 |
| 10b | `CI_NO_CHECKS` | state | yes (with reason) | Nothing has reported for `H`. **Passes automatically** when the expected set is empty and the repo has no Actions workflows (`GET actions/workflows` returns `total_count: 0`) or config sets `ci.none: true` | so repos without CI can merge |
| 11 | `CI_RED` | policy | yes | No considered check is failing. **Waived automatically**, and listed in `waivers` rather than `blockers`, when every failing check is shared with main (§1.5) and config `merge.sharedRed` is `tests` (the default) or `step`. `off` disables the waiver | §4.3, §7 #3246 |
| 12 | `KEY_STEP_SKIPPED` | policy | yes | A configured key step (`ci.keySteps`) concluded `skipped` inside a green job | §6, misleading green |
| 13 | `CHANGES_REQUESTED` | policy | yes | A reviewer's latest non-dismissed `CHANGES_REQUESTED` on an unstructured (human) review | |
| 14 | `FINDINGS_OPEN` | policy | yes | No open finding with severity at or above `config.merge.blockOnSeverity` (default `high`). An unknown severity counts as high. Lower-severity open findings produce a warning with the same code | §8c |
| 15 | `PRECONDITION_UNMET` | policy | yes | Every precondition is `met` or `withdrawn`. `unknown` blocks (fail closed) | §8c5 |
| — | warnings | | | Unresolved human threads, open lower-severity findings, a base change within the last 24 h, existing children, risk `high` | |

### 8.3 Output

```ts
const PlanCheck = z.object({ code: z.string(),
  status: z.enum(["pass","fail","waived","overridden","warn","skipped"]), message: z.string() });
const MergePlan = z.object({
  ref: PrRef, headSha: Sha, method: z.enum(["merge","squash","rebase"]), allowed: z.boolean(),
  checks: z.array(PlanCheck), blockers: z.array(Violation), waivers: z.array(Violation),
  overrides: z.array(z.object({ code: z.string(), reason: z.string() })),
  request: z.object({ method: z.literal("PUT"), path: z.string(), body: z.record(z.unknown()) }),
});
const PrMergeOutput = z.object({
  ref: PrRef, merged: z.literal(true), alreadyMerged: z.boolean(), recoveredFromTransient: z.boolean(),
  method: z.string(), headSha: Sha, mergeCommit: Sha, mergedAt: Iso,
  deletedBranch: z.boolean(),
  children: z.array(z.object({ ref: PrRef, base: z.string() })),
  plan: MergePlan, next: z.array(z.string()), warnings: z.array(Warning),
});
// --dry-run, allowed: { dryRun: true, wouldMerge: true, plan }  (exit 0)
```

### 8.4 Dry-run and refusal shape

A refusal, or a dry run that would be blocked, returns `MERGE_BLOCKED`. The exit code is **5** if any blocker is policy-class, because a human decision is needed. It is **6** if every blocker is state-class: fix or wait, then retry.

```json
{"error":{"code":"MERGE_BLOCKED","message":"2 blockers: CI_PENDING, FINDINGS_OPEN.",
 "hint":"Wait for CI: ghx ci wait powerhouse-inc/powerhouse#3301 --until mergeable. Resolve f_h4x8pz (ghx pr resolve … --status addressed --commit <sha>) or add --override FINDINGS_OPEN --reason \"…\" if the user accepts it.",
 "details":{"plan":{"ref":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","method":"merge","allowed":false,
  "checks":[{"code":"AUTHOR_NOT_VIEWER","status":"pass","message":"author thegoldenmule is you"},
            {"code":"MERGE_CONFLICT","status":"pass","message":"MERGEABLE"},
            {"code":"CI_PENDING","status":"fail","message":"3 checks pending for 9f2c4e1 (ETA ~6m)"},
            {"code":"FINDINGS_OPEN","status":"fail","message":"1 open high finding: f_h4x8pz"}],
  "blockers":[{"code":"CI_PENDING","message":"3 checks pending","overridable":false},
              {"code":"FINDINGS_OPEN","message":"f_h4x8pz (high) is open","overridable":true}],
  "waivers":[],"overrides":[],
  "request":{"method":"PUT","path":"repos/powerhouse-inc/powerhouse/pulls/3301/merge","body":{"sha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","merge_method":"merge"}}}}}}
```

---

## 9. Hidden-block schema

### 9.1 Envelope and encoding

- **Format:** `<!-- ghx:v<MAJOR> <json> -->` on one line. The JSON is a single object.
- **Escaping.** ghx serializes with `JSON.stringify`, then replaces `<` with `\u003c`, `>` with `\u003e` and `&` with `\u0026` (HTML-safe JSON).
  - So `-->`, `<!--` and HTML can never occur inside the payload, and the parse regex `/<!-- ghx:v(\d+) ([^]*?) -->/g` is unambiguous.
  - Example: a body of `a --> b` serializes as `"a --\u003e b"`.
- **Multiple blocks.** A body may hold several blocks, for example a review body with body-only findings. Parsers return all of them, in order.
- **Size.** GitHub caps a body at 65,536 chars. The field caps keep the largest block (`pr`) under about 8 KB.
- **Common fields:** `t` (type), `id`, and `gen` (`"ghx/<semver>"`). The version lives only in the marker.

### 9.2 Types (write schemas: strict)

```ts
const PrBlock = z.object({ t: z.literal("pr"), id, gen, rev: z.number().int().min(1),
  title, description, testing, risk, riskNote?, components, revertPolicy, revertNote?, revertWith?, refs? }).strict();
  // in the PR body; exactly one per PR (extra ⇒ first valid wins + warning DUPLICATE_BLOCK)
const ReviewBlock = z.object({ t: z.literal("review"), id, gen, verdict: Verdict, summary, scope?,
  commit: Sha, findings: z.array(z.string()) }).strict();
  // in the review body
const FindingBlock = z.object({ t: z.literal("finding"), id, gen, review: z.string(), severity: Severity,
  path: RepoPath, line, endLine?, side, alsoAt, title, body, suggestion?, commit: Sha }).strict();
  // in an inline review comment, or in the review body if not inline. No status field: initial status is open
const CommentBlock = z.object({ t: z.literal("comment"), id, gen }).and(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note") }),
  z.object({ kind: z.literal("precondition"), condition: Condition }),
  z.object({ kind: z.literal("status"), state, refs? }),
  z.object({ kind: z.literal("supersede"), by: PrRef }),
  z.object({ kind: z.literal("resolve"), targets: z.array(z.object({
    id: z.string(), status: FindingStatus.or(PreconditionStatus),
    commit: Sha.optional(), note: z.string().max(200).optional(), tracking: IssueRef.optional() })).min(1).max(50) }),
]));
  // in issue comments or thread replies
```

### 9.3 Versioning and the forward-compat rule

- **Within `v1`, changes are additive only:** new optional fields, new enum values, a new `t`, a new `kind`. A rename, removal, semantic change or newly required field means `v2`.
- **Writers** always emit `v1` until a breaking change happens. They use strict schemas, so ghx can never write an invalid block.
- **Readers** use lenient schemas: `.passthrough()`, and enums as `Enum.or(z.string())`.
  - Unknown fields are ignored.
  - Unknown enum values are kept as strings, with the warning `UNKNOWN_ENUM`. **Policy fails closed**: an unknown severity counts as `high`, an unknown risk as `high`, and an unknown precondition type as `unknown`.
  - An unknown `t` or `kind` is reported as `structured: true, kind: null` and ignored by policy, with the warning `UNKNOWN_BLOCK_TYPE`.
- **A newer major version.** A `ghx:v2` block read by v1 is reported as `structured: false` with `blockError: "newer schema v2"` and the warning `SCHEMA_NEWER` ("upgrade ghx").
- **Invalid JSON or a schema failure** is reported as `structured: false` with `blockError`. The item is never dropped.

### 9.4 Status changes: append-only events (chosen over editing)

A finding's status is the fold of the `comment{kind:"resolve"}` events that target it. Events are ordered by GitHub `createdAt`, then by comment `databaseId`, and the last valid event wins. With no events, the status is `open`.

Why not edit the original block instead:
1. **No compare-and-swap.** GitHub's comment PATCH has no `If-Match`, so two agents resolving different findings from the same review would lose each other's updates.
2. **Audit trail.** Events record who changed what, when and with what evidence. Editing erases that history, and today agents keep it in `TRACKER.md` files instead (§8c).
3. **Placement.** A reply in the inline thread puts "Addressed in 9f2c4e1" where a human reads it. ghx also sets GitHub's native thread-resolved flag.
4. **Ownership.** No resolution ever requires editing someone else's comment.

**Who may change what.** Every ghx write goes out under the user's token (§7), so the login cannot tell reviewer from author. The rules are based on trust and facts instead.
- **Trust gate.** A block is honoured only if the comment's `authorAssociation` is in `config.trust.associations` (default `OWNER, MEMBER, COLLABORATOR`) or the author is in `config.trust.bots`. An untrusted block is reported as `structured: false` with the warning `UNTRUSTED_BLOCK`. This stops a drive-by commenter from forging "precondition met" or "addressed".
- **Fact rules:**
  - `addressed` must cite a commit that is reachable from head and not from base. Reads re-verify this. If a force-push drops the commit, the event is reported with `verified: false`, the status falls back to `open`, and ghx warns `EVENT_COMMIT_UNREACHABLE`.
  - `wontfix` and `deferred`, and the precondition overrides `met` and `withdrawn`, need a note.
  - `open` (reopening) is always allowed.
- **Edits:**
  - ghx never edits or deletes a comment after posting it. The one exception is the `pr` block, which `pr edit` rewrites with `rev+1`.
  - A UI edit that keeps the block valid is honoured, and the item is flagged with `edited: true` (or `drift` for the PR body).
  - A UI edit that breaks the block makes the item `structured: false`, with `blockError`.
  - Deleting an event comment removes that event from the fold. The change is visible, which is acceptable.

---

## 10. Passthrough policy

**Decision.** Read-only gh commands on an allowlist run real `gh` inside a JSON envelope. Commands that ghx wraps are refused with a hint to the replacement. Any other write is refused, and so is any unknown command.

| Category | Subcommands | Behaviour |
|---|---|---|
| Allowlisted reads | `pr diff`, `pr list`, `issue view`, `issue list`, `search issues\|prs\|code\|repos\|commits`, `release list\|view`, `repo view`, `workflow list\|view`, `run list`, `run view` (without `--log`/`--log-failed`), `run download` (requires `-D <dir>`; writes local files only), `label list`, `api` (GET only) | Runs `gh` with `-R` injected when the repo has been resolved, and with env `GH_PAGER=cat GH_PROMPT_DISABLED=1 NO_COLOR=1 GH_NO_UPDATE_NOTIFIER=1` |
| Refused, wrapped replacement exists (exit 2, `USE_WRAPPED_COMMAND`) | `pr view` → `pr status`. `pr checks` (including `--watch`) → `ci wait` or `pr status`. `run view --log*` → `ci why`. `run watch` → `ci wait`. `run rerun` → `ci rerun`. `pr create\|edit\|merge\|comment\|review` → the ghx equivalents. `pr ready` → `pr edit {"draft":false}`. `pr close` → `pr comment --close`. `pr reopen` → `ci retrigger`, if retriggering is the intent | The hint carries the exact replacement argv |
| Refused writes (exit 5, `PASSTHROUGH_WRITE_REFUSED`) | Every other mutating subcommand: issue create/comment/edit/close, release create, repo/secret/variable/label writes, workflow run/enable, gist, `pr checkout` (it mutates local git). Also `api` with `-X`/`--method` other than GET, `api` with any of `-f`, `-F`, `--field`, `--raw-field` or `--input` (**gh silently switches these to POST**), and `api graphql` (always a POST) | |
| Unknown | anything else | Exit 2, `UNKNOWN_COMMAND` |

The envelope:

```ts
{ passthrough: { argv: string[], exitCode: number,
  json?: unknown,              // stdout parsed as JSON when possible
  text?: string,               // otherwise, ≤ 32 KB
  stdoutPath?: string,         // > 32 KB: written to the artifact dir
  stdoutBytes: number, stderr?: string /* ≤ 2 KB */ } }
```

- A non-zero gh exit becomes `GH_PASSTHROUGH_FAILED` (8).
- `pr diff` failing with HTTP 406 becomes `DIFF_TOO_LARGE`, with a hint to run a local `git diff` **[G-300]**.

Justification:
- **Agents need these reads.** They use unwrapped reads all the time: `pr diff` (88 calls), `pr list` (59), `issue view` (20), `run list` (296) and `api` GETs (~300) (§2.1, §2.4). Refusing them would push agents back to raw `gh` and pipes.
- **Writes are where the risk is.** There were 0 `gh api` mutations (§2.4) and no reckless writes (§7). The real risk is **policy drift** (§7), which lives in writes. Refusing unvalidated writes makes "writes never fall back silently" (brief 3) true by construction.
- **Harness allowlisting gets simple.** A harness can allowlist `ghx …` knowing that ghx only mutates through validated verbs. That removes the cause of the 19 guard refusals and 6 classifier denials (§3.2).
- **Redirects retrain habits.** Refusing `pr view`, `pr checks` and `run view --log` with the exact replacement retrains a habit worth 534 + 522 + 78 calls (§2.1). It also removes the in-progress log failures **[G-LOGS]**.
- **The output contract holds.** The envelope keeps passthrough output in JSON and within the size bound (brief 3, §9.10).

---

## 11. `ci wait`: the CI watcher (dedicated section)

```
ghx ci wait <target> [<target>…] [--until settled|first-failure|mergeable] [--any]
            [--timeout <dur> | --max <dur>] [--if-eta-under <dur>]
            [--grace <dur>] [--expect-grace <dur>] [--on-head-change restart|stop|stay]
            [--check <glob>]… [--no-diagnose] [--no-compare-main] [--rerun-flaky[=N]] [--final-only]
```

`<target>` is a PR selector, `branch:<name>` or `branch:<name>@<sha>`.

Purpose: block, or stream in the background, until CI for a bound SHA reaches the requested state. It emits one NDJSON line per transition and ends with a self-contained result that has the diagnosis folded in. It replaces 232 sleep/poll commands, 44 Monitor scripts, 41 `--watch` runs, 74 perl alarms and 98 background runs (§5.2, §9.2).

### 11.1 Agent-harness fit

There are two budgets. They are mutually exclusive; passing both is `INPUT_INVALID`.

| Flag | Default | Range | Intended use |
|---|---|---|---|
| `--timeout` | **8m** | 10s–9m30s | A blocking call inside the Claude Code Bash tool, which caps calls at 10 minutes. A value over 9m30s is refused with the hint "use `--max` and run in background", instead of being accepted and then killed by the harness |
| `--max` | — | 1m–6h | A background run read by a line monitor. Turns on a heartbeat every 60 s and a longer minimum poll interval |

- **Why 8m.** It stays under the 10-minute cap with at least 90 s reserved for process start and the terminal diagnosis. The diagnosis covers at most 5 jobs × 2 log fetches, each capped at 8 MB and 20 s, plus the compare-main step.
  - **The diagnosis step has its own 60 s deadline.** If the deadline is hit, the result carries `diagnosis.partial: true`. So the diagnosis can never push a blocking call past the cap.
- **Streaming.** stdout is line-buffered and flushed after every event. Each line is a complete JSON object with a `type`. The last line is always `type:"result"`, or `type:"error"`. `--final-only` prints only the result line, which is a single JSON object (brief 3).
- **Signals.** On SIGINT or SIGTERM, ghx emits a best-effort `result` with `outcome:"interrupted"` and the current summary, then exits 130 or 143.
- **ETA gate (`--if-eta-under <dur>`).** After the first snapshot, if the p90 ETA exceeds `dur`, ghx returns immediately with `outcome:"timeout", reason:"eta-exceeds"` (exit 12) and the ETA. A blocking caller sees nothing until exit, so this is how it decides to run in the background instead of burning 8 minutes. `pr status.ci.eta` exposes the same estimate.

### 11.2 Until-modes

| Mode | Terminal when | Outcome |
|---|---|---|
| `settled` (default) | All considered checks are completed, every required or config-expected check has reported, and every baseline-expected check has reported or aged out | `green`, `red-shared` or `red` |
| `first-failure` | The first considered check fails (it is diagnosed immediately), or everything settles green | `red-shared` or `red` early, otherwise `green` |
| `mergeable` | Settled, **and** `mergeable` has resolved (the §4.3 retry), **and** the `pr merge` CI gate has been evaluated (§8.2 rows 6–12) | `green` if there are no failures and the PR is MERGEABLE. `red-shared` if the only failures are waived as shared with main and the PR is MERGEABLE. `red` otherwise, with `merge.blockers` filled in |

`red-shared` means exit 11 in every mode, so an agent never needs to know which mode produced it.

There is deliberately no `green` mode. Green is only certain once everything settles and becomes impossible at the first failure, so a `green` mode would behave exactly like `first-failure`.

**Considered checks** are all checks reported for the bound SHA, minus `config.ci.ignore` (the §6 noise: `notify-discord`, `CI duration watch`), and filtered by `--check` globs when given.

### 11.3 Expected-check set and phases

ghx builds the expected set at start and rebuilds it on restart. Each entry has a `source`, because the sources differ in strength.

| Source | How it is built | If the check never reports |
|---|---|---|
| `required` | `GET repos/o/r/rules/branches/<base>` (the active rulesets' `required_status_checks`; needs only read access), unioned with the `protection.required_status_checks` summary from `GET repos/o/r/branches/<base>`. Checks that do report also carry `isRequired`. **Spike:** confirm both endpoints are readable without admin. The `…/protection` endpoint needs admin, so it is not used | **Never settles green.** ghx waits until the budget runs out, and the result lists the check in `expectedMissing` |
| `config` | `config.ci.expected: [{name: glob, workflow?, paths?: glob[]}]`, applied only when its `paths` match the PR's files | Same as `required`, when its `paths` match |
| `baseline` | Check names from, in order: (1) the previous head SHA of this PR, or for `branch:` targets the previous commit on that branch; (2) the last PR merged into the same base; (3) the base branch head, which is the weakest source (`confidence:"low"`). Cached | Ages out to `absent` after `--expect-grace` (default 90 s) once everything else has settled, emitting `expected-absent`. This covers path-filtered workflows and main-only jobs |

Phases (`ci.phase`, also shown by `pr status`):
- **`registering`:** zero considered checks have reported. After `--grace` (default **120 s**) with still nothing, the outcome is `no-checks`, exit 14. §3.1 and §5.2 observed checks taking 10–60 s to appear.
- **`partial`:** some checks have reported, but required or config checks are still missing, or baseline checks are still inside their grace. This phase is never terminal as green. It catches `workflow_run`-chained and late-registering workflows that would otherwise make ghx declare done too early.
- **`running`:** every expected check has registered, and some are pending.
- **`settled`:** the terminal phase for `settled` mode.

### 11.4 Fail fast, with a diagnosis attached

- **Diagnosis on failure.** When a considered check turns `fail` (in any mode, unless `--no-diagnose`), ghx immediately runs the `ci why` engine (§12) on that job.
- **It works mid-run.** The failed *job* is complete even while its run is still in progress, so the jobs-logs REST path works **[G-LOGS]**. This is exactly the case where `gh run view --log` failed 16 times (§3.1).
- **Diagnosis events.** ghx emits one `diagnosis` event per failing job, at most 5. Each event carries an inline `excerpt` of at most 15 lines; the full log is at `logPath`.
- **Compare-main.** It runs once per failing workflow (§1.5) unless `--no-compare-main` is given. That is how the stream separates `red` from `red-shared`.
- **Self-contained result.** The terminal `result` repeats the full diagnosis array, so the final line alone answers the question, with no `ci why` follow-up. Diagnosing CI used to take a median of 6 calls (§5.1).

### 11.5 Head-SHA binding

| Target | Bound SHA | On a head change (default) |
|---|---|---|
| PR | `headRefOid` at start | `restart`: emit `head-changed`, rebind, and reset the grace period and per-check state. The total budget does **not** reset |
| `branch:<name>` | The branch head at start | `stay`: keep watching the bound SHA and emit `branch-advanced` for information. Main moves on every merge, and the point is to watch *your* merge commit |
| `branch:<name>@<sha>` | `<sha>` | `stay` |

- With `--on-head-change stop`, a moved head is terminal: `superseded`, exit 13.
- A PR that is closed or merged mid-wait ends with `outcome:"closed"`, exit 13.
- Every check event carries `headSha`, and ghx never mixes SHAs. Agents made 175 + 150 manual SHA cross-checks (§5.4).

### 11.6 ETA and adaptive backoff

**ETA:**
- For each pending check, ghx estimates the median and p90 of that job's duration over the last 10 or fewer successful runs of the same workflow on the base branch.
- Base-branch push job names are used only if they match the PR run's job names. Otherwise ghx falls back to recent `pull_request`-event runs of the same workflow into that base.
- Queued checks add the median queue time.
- Sources:
  - run-level: `GET actions/workflows/{id}/runs?branch=<base>&status=success&per_page=10` (1 call);
  - job-level: `GET actions/runs/{id}/jobs` for at most 3 sampled runs.
- **The estimates are cached on disk per repo and workflow for 24 h**, in 01's cache dir, so most waits pay nothing for this.
- `eta` is the maximum over pending checks of (median − elapsed), clipped at 0, with `p90Seconds` alongside. It is reported in the `start`, `progress` and `heartbeat` events, and in `pr status.ci.eta`.

**Polling:**
- **Primary path: conditional REST, which costs nothing when unchanged.** Every tick sends three requests with `If-None-Match`:
  - `GET pulls/N` for the head and state;
  - `GET commits/{sha}/check-runs?filter=latest&per_page=100`;
  - `GET commits/{sha}/status`.

  304 responses do not count against the rate limit. **Spike:** confirm that `gh api -i` exposes `ETag`, and check how it exits on a 304.
- **Fallback:** one GraphQL query per tick, including `rateLimit{remaining cost resetAt}`.
- **New check suites.** A check suite that appears mid-wait is mapped to its workflow run once, via GraphQL.

**Poll interval:**
- `registering`: 10 s.
- `running`: eta/6, clamped to 15–60 s.
- Within 60 s of a check's expected completion: 10 s.
- After the ETA is overrun: 30 s.
- `--max` mode: at least 30 s.
- When `remaining` drops below 10%, the interval is multiplied by 4 and ghx emits `rate-limit`. When the limit is exhausted, polling pauses until `resetAt`.
- All intervals get ±10% jitter.

### 11.7 Multiple targets

- **Limits.** Up to 10 targets share one poll loop. Each event carries a `target` (the `ref`, or e.g. `branch:main@sha`), and each target has its own until-mode state machine.
- **When it returns.** By default, the call returns once **all** targets are terminal. With `--any`, it returns at the **first** terminal target. That serves merge trains: "merge as ready" (§5.3).
- **Result.** The `result` line holds per-target `results[]` and an aggregate `outcome`. The exit code follows the precedence in §6.1.
- **After a merge.** `pr merge` returns `next: ["ghx ci wait branch:main@<mergeCommit>"]`, which binds the watch to the merge commit.

### 11.8 Flake signals and opt-in rerun

Each failing job gets a `flake` object (§1.5), built from four signals:
- **`same-sha-passed`:** the same job name passed on the same SHA before. Sources: earlier attempts (`GET actions/runs/{id}/attempts/{n}/jobs` for `n < run_attempt`) and other runs for that SHA (`GET actions/runs?head_sha=<sha>`). This is the strongest signal.
- **`main-intermittent`:** the failing test fails intermittently on main. ghx extracts test names from at most 5 recent failed main runs of the job and checks whether those failures are interleaved with passes. The parsed test lists are **cached by job id**, since logs never change.
- **`known-flaky`:** a match in `config.ci.knownFlaky: [{job: glob, test?: glob}]`.
- **`infra-error`:** log patterns such as runner shutdown, `ECONNRESET`, `429 Too Many Requests` (the Docker Hub limit seen in CI logs, §1) and `No space left on device`. `config.ci.infraPatterns` adds more.

`score` is `high` for same-sha-passed or infra-error, `medium` for main-intermittent or known-flaky, and `low` or `none` otherwise. A job is a `candidate` when its score is at least `medium`.

**`--rerun-flaky[=N]`** (default N=1):
- Reruns candidate jobs at most N times per job per wait.
- Uses **the same preflight and limits as `ci rerun`**: the run must be completed, and `ci.maxRerunAttempts` applies.
- Emits a `rerun` event. The new attempt is treated as a continuation, not a head change.
- Makes the invocation a write. `--schema` reports `mutates: "with --rerun-flaky"`, and config `ci.wait.allowAutoRerun: false` disables the flag.
- Without the flag, `ci wait` never mutates (see Pushback).

### 11.9 Event and result schemas

```ts
const Base = z.object({ t: Iso, target: z.string() });
const WaitEvent = z.discriminatedUnion("type", [
  Base.extend({ type: z.literal("start"), headSha: Sha, until: z.string(), budgetSec: z.number(),
    phase: z.string(), counts: CiSummary.shape.counts, expected: z.array(ExpectedCheck),
    eta: CiSummary.shape.eta, advice: z.enum(["block","background"]) }),
  Base.extend({ type: z.literal("phase"), headSha: Sha, from: z.string(), to: z.string() }),
  Base.extend({ type: z.literal("check"), headSha: Sha, name: z.string(), workflow: z.string().nullable(),
    from: z.union([Bucket, z.literal("absent")]), to: Bucket, conclusion: z.string().nullable(),
    required: z.boolean(), runId: z.number().nullable(), jobId: z.number().nullable(), url: z.string() }),
  Base.extend({ type: z.literal("expected-absent"), name: z.string(), source: z.literal("baseline") }),
  Base.extend({ type: z.literal("diagnosis"), headSha: Sha, job: FailingJob /* §12, excerpt ≤ 15 lines */ }),
  Base.extend({ type: z.literal("progress"), headSha: Sha, counts: CiSummary.shape.counts, eta: CiSummary.shape.eta }),
  Base.extend({ type: z.literal("rerun"), runId: z.number(), jobs: z.array(z.string()), reason: z.string() }),
  Base.extend({ type: z.literal("head-changed"), from: Sha, to: Sha, action: z.enum(["restart","stop"]) }),
  Base.extend({ type: z.literal("branch-advanced"), boundSha: Sha, branchHead: Sha }),
  Base.extend({ type: z.literal("rate-limit"), remaining: z.number(), resetAt: Iso, intervalSec: z.number() }),
  Base.extend({ type: z.literal("heartbeat"), elapsedSec: z.number(), counts: CiSummary.shape.counts, eta: CiSummary.shape.eta }),
]);
const Outcome = z.enum(["green","red","red-shared","timeout","superseded","closed","no-checks","interrupted"]);
const TargetResult = z.object({
  target: z.string(), outcome: Outcome, reason: z.string().nullable(),   // e.g. "eta-exceeds"
  headSha: Sha, restarts: z.number(), elapsedSec: z.number(),
  ci: CiSummary, diagnosis: z.object({ failing: z.array(FailingJob), partial: z.boolean() }).nullable(),
  merge: MergeState.pick({ mergeable: true, ready: true, blockers: true, waivers: true }).nullable(), // mergeable mode
  next: z.array(z.string()),
});
const WaitResult = z.object({ type: z.literal("result"), t: Iso, outcome: Outcome,
  exitCode: z.number(), results: z.array(TargetResult) });
// mid-wait fatal: { type:"error", t, error:{code,message,hint,details} } then exit per §6.1
```

A `progress` event is emitted at most once per 60 s while nothing transitions. Heartbeats are emitted only in `--max` mode.

### 11.10 Errors and gh calls

**Errors before the first event** are plain error objects: `BAD_SELECTOR` or `INPUT_INVALID` (2/3), `PR_NOT_FOUND` (7), `GH_*` (8). **Errors mid-wait** that persist after retries are emitted as a `type:"error"` line, with exit 8. Outcomes use exit codes 0 and 10–14.

gh calls per target:
1. A snapshot (a subset of GraphQL Q1: head, state, rollup, `isRequired`), with the oid check **[G-SHA]**.
2. The expected set: the rules and branch endpoints, plus the baseline rollup (cached).
3. ETA baselines (cached).
4. Each tick: the three conditional REST requests, or the GraphQL fallback.
5. On a failure: `actions/jobs/{id}` and `actions/jobs/{id}/logs` **[G-LOGS]**, plus the compare-main and flake calls.
6. In `mergeable` mode: the `mergeable` retry **[G-UNKNOWN]** and the merge CI gate.
7. With `--rerun-flaky`: the `actions/runs/{id}` preflight, then `POST …/rerun-failed-jobs` or `jobs/{id}/rerun`.

---

## 12. `ci why`

```
ghx ci why <pr> [--job <glob>]… [--no-compare-main] [--max-jobs 5] [--excerpt-lines 40]
ghx ci why --run <run-id|run-url> [-R owner/repo]
```

Purpose: answer "why is CI red?" in one call. ghx maps failing checks to jobs and steps, extracts failing tests and errors, writes logs to files, compares with main, and flags flakes and misleading greens (§5.1, §9.1).

```ts
const FailingJob = z.object({
  workflow: z.string(), job: z.string(), jobId: z.number(), runId: z.number(), attempt: z.number(),
  url: z.string(), conclusion: z.string(), required: z.boolean(),
  step: z.object({ number: z.number(), name: z.string() }).nullable(),  // from jobs API, not "UNKNOWN STEP" (§6)
  tests: z.array(z.string()).max(30),             // failing test names
  errors: z.array(z.string()).max(20),            // ##[error], assertion and ERR_* lines, each ≤ 300 chars
  exitLine: z.string().nullable(),                // "Process completed with exit code 1."
  excerpt: z.string(),                            // ≤ --excerpt-lines (cap 120), ANSI- and timestamp-stripped
  logPath: z.string().nullable(), logBytes: z.number().nullable(),
  sameOnMain: SameOnMain, flake: Flake,
});
const CiWhyOutput = z.object({
  ref: PrRef.nullable(), headSha: Sha, ci: CiSummary,
  failing: z.array(FailingJob),
  nonActionsFailing: z.array(Check),              // external statuses: URL only, no logs
  suspicious: z.array(z.object({ workflow: z.string(), job: z.string(), jobId: z.number(),
    step: z.string(), reason: z.enum(["key-step-skipped","no-tests-ran"]) })),  // §6 misleading green
  omitted: z.number(),                            // failing jobs beyond --max-jobs
  next: z.array(z.string()), warnings: z.array(Warning),
});
```

**Log processing** absorbs all of the hand-written glue from §5.1 and §6:
1. Fetch the raw job log from the REST jobs-logs endpoint.
2. Strip ANSI codes (agents did this by hand 101 times) and the leading ISO timestamp on each line.
3. Attribute lines to steps using the `##[group]` markers, cross-checked against the jobs API step list.
4. Extract matches for the built-in patterns ` FAIL `, `×`, `✘`, `AssertionError`, `Tests .* failed`, `##[error]` and `ERR_PNPM` (the grep tokens from §5.1), plus `config.ci.logPatterns`.
5. Write the stripped full log to `<artifacts>/<owner>-<repo>/<runId>/<jobId>.log`.

Errors: `PR_NOT_FOUND` and `RUN_NOT_FOUND` (7), `GH_*` (8). An expired log (past retention) is not an error: it gives `logPath:null` and the warning `LOGS_UNAVAILABLE`. With no failures, the exit is 0 and `failing` is `[]`.

gh calls:
1. The snapshot rollup with the oid check **[G-SHA]**. With `--run`: `actions/runs/{id}` and its `head_sha`.
2. For each failing Actions job, up to `--max-jobs`: `GET actions/jobs/{id}` for the steps and `GET actions/jobs/{id}/logs` **[G-LOGS]**. ghx never calls `gh run view --log`.
3. For key steps: `GET actions/runs/{id}/jobs` for each run that has green jobs matching `ci.keySteps`.
4. Compare-main once per failing workflow (§1.5).
5. Flake signals (§11.8).

---

## 13. `ci rerun` and `ci retrigger`

### 13.1 `ci rerun`

```
ghx ci rerun <pr> [--job <glob>]… [--expect-head <sha>] [--override RERUN_LIMIT --reason "…"] [--dry-run]
```

Purpose: rerun the failed jobs of completed runs, for the current head only. Agents did 44 reruns after parsing ids by hand, and 2 were refused (§5.4).

Behaviour:
- Only failing Actions runs whose `head_sha` equals `H` are considered.
- A run that is not `completed` is skipped with reason `RUN_IN_PROGRESS`. GitHub refuses those reruns, which caused the "already running" error in §3.1.
- A run whose `run_attempt` has reached `config.ci.maxRerunAttempts` (default 3) is skipped with reason `RERUN_LIMIT`.
- `--job` targets individual failed jobs (`POST actions/jobs/{id}/rerun`). Otherwise ghx calls `POST actions/runs/{id}/rerun-failed-jobs`.
- If nothing can be rerun, the error is `NO_FAILED_RUNS`, `RUN_IN_PROGRESS` or `RERUN_LIMIT`, checked in that order.
- **The hint points out that a rerun reuses the original event's merge ref.** After a base change, use `ci retrigger` instead.

Output: `{ref, headSha, rerun: [{runId, workflow, jobs: string[], previousAttempt, url}], skipped: [{runId, workflow, reason}], next: ["ghx ci wait <ref>"], warnings}`.

gh calls:
1. The snapshot rollup **[G-SHA]**.
2. `GET actions/runs/{id}` for each distinct failing run.
3. The rerun POSTs.

### 13.2 `ci retrigger`

```
ghx ci retrigger <pr> [--expect-head <sha>] [--wait-for-runs 60s] [--override AUTHOR_NOT_VIEWER --reason "…"] [--dry-run]
```

Purpose: fire fresh `pull_request` workflows, for example after a base change, without a hand-written `close && reopen && sleep` (§5.4).

**Mechanism.** REST `PATCH pulls/N {state:"closed"}`, then `{state:"open"}`. `reopened` is one of the default `pull_request` activity types. It creates a new event with the current merge ref, which a rerun cannot do.

**Preflight:**
- The PR must be open (`PR_NOT_OPEN`).
- The head branch must exist (`GET branches/<head>`). A PR cannot be reopened once its head branch is deleted, so a missing branch gives `HEAD_BRANCH_MISSING`.
- The base branch must exist (`BRANCH_MISSING`).
- The author must be the viewer (`AUTHOR_NOT_VIEWER`, overridable).
- `--expect-head` must match.

**Failure handling.**
- If reopening fails, ghx retries it 3 times with backoff. It then gives `REOPEN_FAILED` (8) with the exact manual command, so the PR is never silently left closed.
- After reopening, ghx polls for new check suites on `H` created after the reopen, for up to `--wait-for-runs`. If none appear, it warns `NO_NEW_RUNS`: "workflows may not listen to `reopened`".

Output: `{ref, headSha, closedAt, reopenedAt, newRuns: [{runId, workflow, status, url}], next: ["ghx ci wait <ref>"], warnings}`.

---

## 14. Worked example

**Setup.** The repo is `powerhouse-inc/powerhouse`. Its config components include `reactor`, `reactor-api`, `shared`, `connect`, `switchboard`, `codegen`, `vetra`, `docs` and `ci`. `ci.ignore` is `["notify-discord", "CI duration watch"]`, and `merge.method` is `merge`.

### 14.1 Input (`ghx pr create --input pr.json`)

```json
{
  "title": "fix(reactor): bind documentId when signing actions on the write path",
  "description": "The primary write path in reactor-client signed actions without binding documentId, so a signature made for one document also verified on another.\nsignAction now always binds the target documentId, and verify rejects unbound candidates instead of accepting them.",
  "testing": [
    {"kind": "unit", "command": "pnpm --filter @powerhousedao/reactor test -- signature", "result": "pass", "notes": "4 new cases: unbound and cross-document signatures"},
    {"kind": "integration", "command": "pnpm --filter @powerhousedao/reactor-api test", "result": "pass"},
    {"kind": "typecheck", "command": "pnpm tsc -b", "result": "pass"}
  ],
  "risk": "medium",
  "riskNote": "Clients that sign without a documentId now get a verification error instead of silent acceptance.",
  "components": ["reactor", "shared"],
  "revertPolicy": "revert-safe",
  "base": "main",
  "head": "fix/reactor-bind-document-id",
  "refs": {"closes": ["#2894"]}
}
```

How this input passes validation:
- **Title:** 68 chars (at most 72), conventional, and its scope `reactor` is both in config and in `components`.
- **Description:** 2 lines, about 265 chars, with no structure.
- **Testing:** 3 of 3 pass, and every command can be re-run from the repo root.
- **Risk:** `medium`, with `riskNote`.
- **Draft:** base is the default branch, so `draft` derives to false.

### 14.2 Rendered PR body (#3301)

```markdown
The primary write path in reactor-client signed actions without binding documentId, so a signature made for one document also verified on another.
signAction now always binds the target documentId, and verify rejects unbound candidates instead of accepting them.

Risk: medium · Components: reactor, shared · Revert: revert-safe · Tests: 3/3 pass (unit, integration, typecheck) · Closes #2894

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"t":"pr","id":"p_k3m9qa","gen":"ghx/0.1.0","rev":1,"title":"fix(reactor): bind documentId when signing actions on the write path","description":"The primary write path in reactor-client signed actions without binding documentId, so a signature made for one document also verified on another.\nsignAction now always binds the target documentId, and verify rejects unbound candidates instead of accepting them.","testing":[{"kind":"unit","command":"pnpm --filter @powerhousedao/reactor test -- signature","result":"pass","notes":"4 new cases: unbound and cross-document signatures"},{"kind":"integration","command":"pnpm --filter @powerhousedao/reactor-api test","result":"pass"},{"kind":"typecheck","command":"pnpm tsc -b","result":"pass"}],"risk":"medium","riskNote":"Clients that sign without a documentId now get a verification error instead of silent acceptance.","components":["reactor","shared"],"revertPolicy":"revert-safe","refs":{"closes":["#2894"]}} -->
```

### 14.3 The review, the fix and other feedback

**A review against head `4b1e7d2`.** It is posted with `ghx pr review powerhouse-inc/powerhouse#3301 --input review.json`:

```json
{"verdict": "request-changes",
 "summary": "The signing fix covers createDocument and addActions, but deleteDocument still signs without a documentId.",
 "scope": "8 files on fix/reactor-bind-document-id plus the sign/verify call graph",
 "findings": [
  {"severity": "high", "path": "packages/reactor/src/client/reactor-client.ts", "line": 1071,
   "alsoAt": [{"path": "packages/reactor/src/client/reactor-client.ts", "line": 1111}],
   "title": "deleteDocument still signs without documentId",
   "body": "deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document."},
  {"severity": "low", "path": "packages/shared/document-model/crypto.ts", "line": 179,
   "title": "Rejection error does not name the documentId",
   "body": "The thrown error says \"signature not bound\" without the expected and actual documentId, which makes client logs hard to trace."}]}
```

The viewer is the author, so the review is posted as `COMMENT` with `verdictDowngraded: true`. The inline comment for the high finding:

```markdown
**[high] deleteDocument still signs without documentId**

deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document.

Also at: `packages/reactor/src/client/reactor-client.ts:1111`

<!-- ghx:v1 {"t":"finding","id":"f_h4x8pz","gen":"ghx/0.1.0","review":"r_7tq2wd","severity":"high","path":"packages/reactor/src/client/reactor-client.ts","line":1071,"side":"RIGHT","alsoAt":[{"path":"packages/reactor/src/client/reactor-client.ts","line":1111}],"title":"deleteDocument still signs without documentId","body":"deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document.","commit":"4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47"} -->
```

The review body ends with:

```
<!-- ghx:v1 {"t":"review","id":"r_7tq2wd","gen":"ghx/0.1.0","verdict":"request-changes","summary":"The signing fix covers createDocument and addActions, but deleteDocument still signs without a documentId.","scope":"8 files on fix/reactor-bind-document-id plus the sign/verify call graph","commit":"4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47","findings":["f_h4x8pz","f_n2c6rv"]} -->
```

**The fix.** The agent pushes `9f2c4e1`, then runs `ghx pr resolve powerhouse-inc/powerhouse#3301 f_h4x8pz --status addressed --commit 9f2c4e1`. That posts a reply in the thread and resolves it:

```markdown
Addressed in 9f2c4e1.

<!-- ghx:v1 {"t":"comment","id":"c_w5j1ve","gen":"ghx/0.1.0","kind":"resolve","targets":[{"id":"f_h4x8pz","status":"addressed","commit":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d"}]} -->
```

**Other feedback:**
- A human comment from `maria-dev` (MEMBER), with no block.
- A bot comment from `github-actions[bot]` that starts with `<!-- ci-duration-watch -->`.

### 14.4 `ci wait` stream for head `9f2c4e1`

The command was `ghx ci wait powerhouse-inc/powerhouse#3301 --until first-failure --max 30m`, run in the background.

```
{"type":"start","t":"2026-10-21T16:23:05Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","until":"first-failure","budgetSec":1800,"phase":"partial","counts":{"pass":0,"fail":0,"pending":9,"skipped":0,"cancelled":0,"neutral":0,"ignored":1},"expected":[{"name":"Test Reactor (shard 1/3)","workflow":"CI","source":"baseline","state":"reported"},{"name":"e2e-tests","workflow":"E2E","source":"baseline","state":"missing"}],"eta":{"seconds":1080,"p90Seconds":1320,"basis":"CI@main: 10 runs, E2E@main: 8 runs"},"advice":"background"}
{"type":"phase","t":"2026-10-21T16:23:41Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","from":"partial","to":"running"}
{"type":"check","t":"2026-10-21T16:27:12Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","name":"Typecheck","workflow":"CI","from":"pending","to":"pass","conclusion":"success","required":true,"runId":37948190914,"jobId":111978835001,"url":"https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835001"}
{"type":"check","t":"2026-10-21T16:41:05Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","name":"Test Reactor (shard 1/3)","workflow":"CI","from":"pending","to":"fail","conclusion":"failure","required":false,"runId":37948190914,"jobId":111978835495,"url":"https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495"}
{"type":"diagnosis","t":"2026-10-21T16:41:19Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","job":{"workflow":"CI","job":"Test Reactor (shard 1/3)","jobId":111978835495,"runId":37948190914,"attempt":1,"url":"https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495","conclusion":"failure","required":false,"step":{"number":6,"name":"Run tests"},"tests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"errors":["AssertionError: expected 3 to equal 4"],"exitLine":"Process completed with exit code 1.","excerpt":"× should converge after reshuffle rebroadcast between two connect reactors 20056ms\n  AssertionError: expected 3 to equal 4","logPath":"/…/ghx/powerhouse-inc-powerhouse/37948190914/111978835495.log","logBytes":2318840,"sameOnMain":{"verdict":"same-tests","mainBranch":"main","mainRunId":37950011223,"mainSha":"c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3","mainRunAt":"2026-10-21T15:58:19Z","prTests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"mainTests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"newTests":[]},"flake":{"candidate":true,"score":"medium","signals":[{"kind":"main-intermittent","detail":"failed 3 of last 10 main runs, interleaved with passes"}]}}}
{"type":"result","t":"2026-10-21T16:41:20Z","outcome":"red-shared","exitCode":11,"results":[{"target":"powerhouse-inc/powerhouse#3301","outcome":"red-shared","reason":null,"headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","restarts":0,"elapsedSec":1095,"ci":{"…":"CiSummary as in 14.5, phase running"},"diagnosis":{"failing":["…same FailingJob as the diagnosis event…"],"partial":false},"merge":null,"next":["ghx pr merge powerhouse-inc/powerhouse#3301 --expect-head 9f2c4e1 --dry-run"]}]}
```

The `start` event advises `background` because the p90 ETA (22m) exceeds the 8m blocking default. This caller ran it in the background with `--max 30m`. A blocking caller would have used `--if-eta-under 7m` and been sent back immediately with exit 12. `elapsedSec` (1095) is within `budgetSec` (1800).

### 14.5 `ghx pr status powerhouse-inc/powerhouse#3301`, after CI settled

```json
{
  "ref": "powerhouse-inc/powerhouse#3301",
  "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301",
  "number": 3301,
  "title": "fix(reactor): bind documentId when signing actions on the write path",
  "author": {"login": "thegoldenmule", "isViewer": true, "isBot": false, "association": "MEMBER"},
  "state": "OPEN", "draft": false,
  "createdAt": "2026-10-21T14:02:11Z", "updatedAt": "2026-10-21T16:30:40Z",
  "base": {"ref": "main", "isDefault": true},
  "head": {"ref": "fix/reactor-bind-document-id", "sha": "9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d"},
  "changes": {"files": 8, "additions": 142, "deletions": 37, "commits": 2},
  "description": {
    "text": "The primary write path in reactor-client signed actions without binding documentId, so a signature made for one document also verified on another.\nsignAction now always binds the target documentId, and verify rejects unbound candidates instead of accepting them.",
    "structured": true, "drift": []
  },
  "meta": {
    "id": "p_k3m9qa", "rev": 1, "gen": "ghx/0.1.0",
    "risk": "medium",
    "riskNote": "Clients that sign without a documentId now get a verification error instead of silent acceptance.",
    "components": ["reactor", "shared"],
    "revertPolicy": "revert-safe", "revertNote": null, "revertWith": [],
    "testing": [
      {"kind": "unit", "command": "pnpm --filter @powerhousedao/reactor test -- signature", "result": "pass", "notes": "4 new cases: unbound and cross-document signatures"},
      {"kind": "integration", "command": "pnpm --filter @powerhousedao/reactor-api test", "result": "pass"},
      {"kind": "typecheck", "command": "pnpm tsc -b", "result": "pass"}
    ],
    "refs": {"closes": ["#2894"]}
  },
  "metaError": null,
  "merge": {
    "mergeable": "MERGEABLE", "settled": true, "mergeStateStatus": "UNSTABLE",
    "reviewDecision": null, "method": "merge", "ready": true,
    "blockers": [],
    "waivers": [{"code": "CI_RED", "message": "Test Reactor (shard 1/3) fails with the same test on main run 37950011223 (c0ffee1).", "overridable": true}],
    "warnings": [{"code": "FINDINGS_OPEN", "message": "1 open low finding (f_n2c6rv); below merge.blockOnSeverity (high).", "overridable": true}],
    "mergedAt": null, "mergeCommit": null
  },
  "ci": {
    "headSha": "9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d", "forHeadSha": true,
    "state": "red", "phase": "settled",
    "counts": {"pass": 21, "fail": 1, "pending": 0, "skipped": 1, "cancelled": 0, "neutral": 0, "ignored": 2},
    "failing": [{
      "name": "Test Reactor (shard 1/3)", "workflow": "CI", "kind": "actions",
      "bucket": "fail", "status": "completed", "conclusion": "failure", "required": false,
      "runId": 37948190914, "jobId": 111978835495, "attempt": 1,
      "url": "https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495",
      "startedAt": "2026-10-21T16:23:30Z", "completedAt": "2026-10-21T16:41:02Z",
      "sameOnMain": {
        "verdict": "same-tests", "mainBranch": "main", "mainRunId": 37950011223,
        "mainSha": "c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3", "mainRunAt": "2026-10-21T15:58:19Z",
        "prTests": ["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],
        "mainTests": ["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],
        "newTests": []
      },
      "flake": null
    }],
    "pending": [],
    "ignored": ["notify-discord", "CI duration watch"],
    "expectedMissing": [],
    "eta": null,
    "next": ["ghx ci why powerhouse-inc/powerhouse#3301"]
  },
  "feedback": {
    "reviews": [{
      "id": "r_7tq2wd", "structured": true,
      "author": {"login": "thegoldenmule", "isViewer": true, "isBot": false, "association": "MEMBER"},
      "verdict": "request-changes", "githubState": "COMMENTED", "verdictDowngraded": true,
      "submittedAt": "2026-10-21T15:40:03Z",
      "commit": "4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47", "outdated": true,
      "summary": "The signing fix covers createDocument and addActions, but deleteDocument still signs without a documentId.",
      "truncated": false, "findingIds": ["f_h4x8pz", "f_n2c6rv"],
      "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#pullrequestreview-2398765432"
    }],
    "findings": [
      {
        "id": "f_h4x8pz", "reviewId": "r_7tq2wd", "severity": "high",
        "path": "packages/reactor/src/client/reactor-client.ts", "line": 1071, "endLine": null,
        "alsoAt": [{"path": "packages/reactor/src/client/reactor-client.ts", "line": 1111}],
        "title": "deleteDocument still signs without documentId",
        "body": "deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document.",
        "truncated": false, "inline": true,
        "commit": "4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47", "outdated": true,
        "status": "addressed",
        "statusEvent": {"id": "c_w5j1ve", "by": "thegoldenmule", "at": "2026-10-21T16:22:45Z",
                        "commit": "9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d", "note": null, "verified": true,
                        "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834570012"},
        "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834567890"
      },
      {
        "id": "f_n2c6rv", "reviewId": "r_7tq2wd", "severity": "low",
        "path": "packages/shared/document-model/crypto.ts", "line": 179, "endLine": null, "alsoAt": [],
        "title": "Rejection error does not name the documentId",
        "body": "The thrown error says \"signature not bound\" without the expected and actual documentId, which makes client logs hard to trace.",
        "truncated": false, "inline": true,
        "commit": "4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47", "outdated": false,
        "status": "open", "statusEvent": null,
        "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834567955"
      }
    ],
    "comments": [
      {
        "id": "c_w5j1ve", "source": "inline",
        "author": {"login": "thegoldenmule", "isViewer": true, "isBot": false, "association": "MEMBER"},
        "at": "2026-10-21T16:22:45Z", "body": "Addressed in 9f2c4e1.", "truncated": false,
        "structured": true, "kind": "resolve",
        "path": "packages/reactor/src/client/reactor-client.ts", "line": 1071,
        "threadResolved": true, "inReplyTo": "f_h4x8pz", "edited": false, "blockError": null,
        "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834570012"
      },
      {
        "id": "ic:2412345678", "source": "issue",
        "author": {"login": "maria-dev", "isViewer": false, "isBot": false, "association": "MEMBER"},
        "at": "2026-10-21T16:05:12Z",
        "body": "Does connect need a Switchboard release before this lands, or is the verify change backward compatible?",
        "truncated": false, "structured": false, "kind": null, "path": null, "line": null,
        "threadResolved": null, "inReplyTo": null, "edited": false, "blockError": null,
        "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-2412345678"
      }
    ],
    "bots": [{
      "id": "ic:2412399001", "source": "issue", "author": "github-actions[bot]",
      "at": "2026-10-21T16:30:40Z", "marker": "ci-duration-watch",
      "summary": "⚠️ CI duration regression: Test Reactor (shard 2/3) 14m02s vs baseline median 9m40s",
      "path": null, "line": null,
      "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-2412399001"
    }],
    "counts": {"reviews": 1, "findingsTotal": 2, "findingsOpen": 1, "comments": 2, "bots": 1,
               "unresolvedHumanThreads": 0, "omitted": 0}
  },
  "openFindings": ["f_n2c6rv"],
  "preconditions": [],
  "stack": {"parent": null, "declaredParent": null, "children": [], "baseChanges": []},
  "warnings": [],
  "fetchedAt": "2026-10-22T09:15:00Z"
}
```

`merge.ready` is `true` for two reasons. The only red check is waived because main has the same failure (§4.3). The only open finding is low severity. The next step would be `ghx pr merge powerhouse-inc/powerhouse#3301 --expect-head 9f2c4e1`.

---

## 15. Config keys this API needs (for 01)

- `components: [{name, paths?: glob[], minRisk?: Risk}]`
- `title.types`, `title.scopeRequired`
- `render.mode` (`trailer|details`), `render.footer`, `render.descriptionMaxChars`
- `create.requirePassingTest`
- `merge.method`, `merge.allowedMethods`, `merge.sharedRed` (`tests|step|off`), `merge.blockOnSeverity`, `merge.requireOwnPr`, `merge.deleteBranch`
- `ci.none`, `ci.ignore`, `ci.expected`, `ci.keySteps`, `ci.logPatterns`, `ci.infraPatterns`, `ci.knownFlaky`, `ci.maxRerunAttempts`, `ci.wait.allowAutoRerun`
- `trust.associations`, `trust.bots`, `bots.logins`, `bots.markers`
- From 01: the artifact dir and cache dir, holding log files, ETA baselines and the parsed-test cache.
- Spikes for 01/03:
  - whether `gh api -i` exposes ETags, and how it exits on a 304;
  - whether the rules and branch endpoints are readable without admin;
  - whether `gh api` follows the job-logs redirect.

---

## 16. Pushback

1. **`ci wait` writes NDJSON, but brief 3 says "errors are a structured JSON object on stdout".** The coordinator endorsed the stream, and the evidence is the transition-diffing Monitor scripts (§5.2). Every line is JSON, and the last line is the result or error object. `--final-only` restores the single-object contract.
2. **`ci wait --rerun-flaky` blurs the read/write split (§9.7).** The coordinator asked for it. It is opt-in, reported as `mutates` in `--schema`, and uses `ci rerun`'s preflight and limits. Repos can disable it. Harness allowlists should not grant `ghx ci wait *` blanket write trust when the flag is in use.
3. **`pr edit` is added to v1, though brief 8 does not list it.** The evidence is 35 edits across 24 PRs, with bodies edited up to 4 times (§4.2). Because passthrough refuses writes, agents would otherwise reach for raw `gh pr edit --body` and destroy the hidden block. It also covers `pr ready` (12 calls) and base retargets. It is cheap because it reuses the create validator and renderer. `pr resolve` is a separate command name, but its scope is within §9.6.
4. **GitHub's native review verdicts will not reflect ghx verdicts on the user's own PRs.** All agents use the user's token, and GitHub forbids approving or requesting changes on your own PR. These reviews post as `COMMENT`, and the verdict lives in the block (`verdictDowngraded`). `reviewDecision` stays empty, as it already is in practice (§7). For the same reason, "human vs ghx" is decided by whether a block is present, not by login, and the authority rules are based on facts (§9.4).
5. **The brief's input object gains conditional fields:** `riskNote` (for medium/high), `revertNote` and `revertWith`. The brief's "at most 3 lines" description also gains a 500-char cap and a ban on markdown structure. Both encode the user's two corrections directly (§4.1).
6. **Exit codes go beyond the four outcomes the coordinator named.**
   - `11 red-shared`, the same in every until-mode, is separate because the user's standing rule makes it mergeable (§4.3). Folding it into `red` would force a follow-up call.
   - `14 no-checks` is separate because treating "nothing registered" as green, or as a timeout, is the misread behind the 11 cases in §3.1.
7. **Passthrough returns an envelope, not raw gh output.** This keeps the brief's JSON and size contract, at the cost of nesting gh's exact stdout under `passthrough.json` or `passthrough.text`.

---

### Critical Files for Implementation
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/plans/00-brief.md
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/research/gh-usage-findings.md
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/plans/02-api.md: this plan, once saved.
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/plans/01-scaffolding.md: the parallel plan. It must provide the block codec (with §9.1's escaping rule and multi-block parsing), the config keys in §15, and the artifact and cache dirs.