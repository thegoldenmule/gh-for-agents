# 02: ghx command API

Status: draft. It follows `00-brief.md` (including the user's confirmed decisions of 2026-10-22) and `01-scaffolding.md`. Evidence comes from `docs/research/gh-usage-findings.md`, cited as §N. 01 owns the framework, gh exec layer, config loader, block codec, output sink and stream runner. This file owns **what** the commands are and their contracts.

---

## 0. Decisions at a glance

| Topic | Decision | Evidence |
|---|---|---|
| v1 commands | `pr create` (`--batch`), `pr edit`, `pr status`, `pr feedback`, `pr comment`, `pr review`, `pr resolve`, `pr merge`, `ci why`, `ci wait`, `ci rerun`, `ci retrigger` | brief 8; §9.1–9.6, §9.8; `pr edit` in Pushback |
| Read verb | `pr status`. `ghx pr view` is refused with a hint naming `pr status` | §9.3; 534 habitual `pr view` calls (§2.1) |
| Flags vs JSON | Identifiers, modes, durations and overrides are flags. Prose goes in JSON via `--input <file>` or an explicit `--input -`. Stdin is never read implicitly | §4.1; brief 2026-10-22 |
| Config | `.github/ghx.json` | brief 2026-10-22 |
| PR selector | `N`, `#N`, `owner/repo#N` or a URL. Every output carries `ref: "owner/repo#N"` | §3.1, §4.1 sektar #3258 |
| Read/write split | Reads (`pr status`, `pr feedback`, `ci why`, `ci wait`) run on 01's mechanically read-only gh client and never mutate, with no exceptions | §3.2, §9.7; brief |
| Passthrough | None. An unknown command is refused with a hint: the ghx replacement, or the raw `gh` read to run | §2.4, §3.2, §7; brief steering |
| Hidden block | `<!-- ghx:v1 {json} -->` with 4 types: `pr`, `review`, `finding`, `comment`. Strict on write, lenient on read. Status changes are append-only events | §8c |
| Trust | A block counts only if its author is `OWNER`, `MEMBER` or `COLLABORATOR` (configurable) | prompt-injection defence |
| Merge | REST `PUT /pulls/N/merge` with `sha` pinned. The policy engine is shared with `pr status` `merge.blockers`. Overrides take a code plus `--reason` | §4.3, §7 |
| `ci wait` | NDJSON events, an expected-check model, the diagnosis folded into the summary, ETA, multiple targets and flake signals. Default timeout 8m; `--max` for background runs | §5.2, §9.2; §11 |

Gotcha tags used in the gh-call lists:

| Tag | Gotcha |
|---|---|
| **[G-LOGS]** | `run view --log` refuses mid-run, so ghx uses the jobs-logs REST API (§0, §5.1) |
| **[G-UNKNOWN]** | `mergeable` is `UNKNOWN` after a push, so ghx does a bounded retry (§5.2, §9.3) |
| **[G-300]** | Diffs and compares cap at 300 files (§3.1, §9.10) |
| **[G-RETARGET]** | GitHub auto-retargets the base branch (§4.1) |
| **[G-CWD]** | The cwd repo may not be the PR's repo (§3.1) |
| **[G-SHA]** | Pin the head SHA (§4.3, §5.4) |

---

## 1. Conventions shared by all commands

### 1.1 Grammar and flags

The grammar is `ghx <noun> <verb> [selector…] [flags]`, where noun ∈ `pr`, `ci`. Global flags belong to 01. This API relies on:

| Flag | Applies to | Meaning |
|---|---|---|
| `-R, --repo owner/name` | all | Explicit repo |
| `--input <file\|->` | commands with JSON input | Path to the JSON, or `-` for stdin. **Required.** Stdin is never read implicitly; a missing `--input` gives `USAGE_INPUT_MISSING`. Documented agent path: write the JSON with the Write tool, then pass `--input file.json` |
| `--dry-run` | writes | Runs all validation, policy and reads with no mutation, prints the plan, and exits as the real call would |
| `--expect-head <sha>` | `pr merge`, `pr review`, `ci rerun`, `ci retrigger` | Refuses with `HEAD_MOVED` unless the head is this SHA (7–40 hex) **[G-SHA]** |
| `--timeout <dur>` | all | 01's deadline with per-command default and max. `ci wait` has its own rules (§11.1) |
| `--schema`, `--pretty`, `--max-bytes` | all | As defined in 01 |

There is no `--json`, `--jq`, `--web`, `--watch` or pager. Every output has a fixed, typed schema (§3.1, §9.9).

### 1.2 Repo and PR resolution [G-CWD]

1. The repo comes from, in order: the selector, `--repo`, then the cwd (`gh repo view --json nameWithOwner`).
2. If the selector and `--repo` disagree, the command fails with `VALIDATION`.
3. If the repo came from the cwd and the PR isn't found, the command fails with `PR_NOT_FOUND`. The hint names the cwd repo and suggests `owner/repo#N` (§3.1).
4. If an explicit repo differs from the cwd repo:
   - reads proceed with the warning `CWD_REPO_MISMATCH`;
   - config is fetched from the target repo (§15, ask 1);
   - writes skip any local-git steps, with a warning.
5. Every output includes `ref`. Follow-up suggestions go in `next[]`.

### 1.3 Output contract (brief 2026-10-22; 01 runner)

stdout takes exactly one of three shapes:

1. **One bounded JSON document.** It includes `ref` where applicable and `warnings: {code, message}[]`. Commands stay small by design: items are truncated (`truncated: true`) and logs go to artifact files (§6). The bound is 01's `maxBytes`, default **16 KB**.
2. **NDJSON, `ci wait` only.** Each line is `{type, seq, at, …}`. The last line is always `summary` or `error`. Each line is at most 4,096 bytes.
3. **Spill.** If a document would exceed the bound, stdout is `{"spilled": true, "path", "bytes", "command"}` with exit 0.

Errors are `{"error": {"code", "message", "hint", "details"}}`. All four keys are always present, with `null` when empty. The exit code is non-zero (§6).

### 1.4 IDs

- Format: prefix plus 6 lowercase Crockford base32 characters. Prefixes are `p_` (PR), `r_` (review), `f_` (finding) and `c_` (comment).
- Regex: `^[prfc]_[0-9a-hjkmnp-tv-z]{6}$`.
- Generated client-side and unique per PR.
- Unstructured items get synthetic ids: `ic:<id>` (issue comment), `rc:<id>` (review comment), `rv:<id>` (review).

### 1.5 Shared schemas (zod-ish)

```ts
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const ShaInput = z.string().regex(/^[0-9a-f]{7,40}$/);
const PrRef = z.string().regex(/^(?:[\w.-]+\/[\w.-]+)?#\d+$/);
const IssueRef = PrRef;
const Iso = z.string().datetime();
const OneLine = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\r\n]/.test(s), "single line");
const RepoPath = z.string().min(1).max(400).refine(p => !p.startsWith("/") && !p.split("/").includes(".."));
const Warning = z.object({ code: z.string(), message: z.string() });
const Component = z.enum(config.components.map(c => c.name));   // from .github/ghx.json
const Risk = z.enum(["trivial","low","medium","high"]);
const RevertPolicy = z.enum(["revert-safe","revert-with-followup","coordinated","forward-fix-only"]);
const Severity = z.enum(["high","medium","low"]);
const Verdict = z.enum(["approve","request-changes","comment"]);
const FindingStatus = z.enum(["open","addressed","wontfix","deferred"]);
const PreconditionStatus = z.enum(["met","unmet","unknown","withdrawn"]);
const Author = z.object({ login: z.string(), isViewer: z.boolean(), isBot: z.boolean(),
  association: z.enum(["OWNER","MEMBER","COLLABORATOR","CONTRIBUTOR","FIRST_TIME_CONTRIBUTOR","FIRST_TIMER","MANNEQUIN","NONE"]) });
```

**Risk** values:

| Value | Meaning |
|---|---|
| `trivial` | No runtime change: docs, comments, tests only, or CI that doesn't gate releases |
| `low` | Change inside one component, tested, revertible alone |
| `medium` | Change across components or in a shared or public API, or only partial tests. Needs `riskNote` |
| `high` | Persisted formats or migrations, auth, crypto or signing, the release pipeline, or hard to revert. Needs `riskNote` |

**Revert policy** values:

| Value | Meaning | Requires |
|---|---|---|
| `revert-safe` | Reverting the merge commit fully undoes the change | — |
| `revert-with-followup` | Revertible, but an extra step is needed (config, cache, re-publish) | `revertNote` |
| `coordinated` | Revert only together with other PRs. 16 of 73 PRs were stacked (§4.1) | `revertWith` (≥1 PR) |
| `forward-fix-only` | Don't revert; fix forward | `revertNote` |

**CI summary** (shared by `pr status`, `ci why` and `ci wait`):

```ts
const Bucket = z.enum(["pass","fail","pending","skipped","cancelled","neutral"]);
const Check = z.object({ name: z.string(), workflow: z.string().nullable(), kind: z.enum(["actions","status","app"]),
  bucket: Bucket, status: z.enum(["expected","queued","in_progress","waiting","completed"]),
  conclusion: z.string().nullable(), required: z.boolean(),
  runId: z.number().nullable(),     // checkSuite.workflowRun.databaseId (no link parsing, §2.3)
  jobId: z.number().nullable(),     // CheckRun.databaseId == Actions job id
  attempt: z.number().nullable(), url: z.string().url(), startedAt: Iso.nullable(), completedAt: Iso.nullable() });
const SameOnMain = z.object({ verdict: z.enum(["same-tests","same-step","different","main-green","no-main-run","not-compared"]),
  mainBranch: z.string(), mainRunId: z.number().nullable(), mainSha: Sha.nullable(), mainRunAt: Iso.nullable(),
  prTests: z.array(z.string()).max(30), mainTests: z.array(z.string()).max(30), newTests: z.array(z.string()).max(30) });
const Flake = z.object({ candidate: z.boolean(), score: z.enum(["high","medium","low","none"]),
  signals: z.array(z.object({ kind: z.enum(["same-sha-passed","main-intermittent","known-flaky","infra-error"]), detail: z.string() })) });
const FailingCheck = Check.extend({ sameOnMain: SameOnMain.nullable(), flake: Flake.nullable() });  // null = not computed
const ExpectedCheck = z.object({ name: z.string(), workflow: z.string().nullable(),
  source: z.enum(["required","config","baseline"]), state: z.enum(["missing","reported","absent"]) });
const CiSummary = z.object({ headSha: Sha, forHeadSha: z.literal(true),
  state: z.enum(["green","red","pending","no-checks"]), phase: z.enum(["registering","partial","running","settled"]),
  counts: z.object({ pass: z.number(), fail: z.number(), pending: z.number(), skipped: z.number(), cancelled: z.number(), neutral: z.number(), ignored: z.number() }),
  failing: z.array(FailingCheck), pending: z.array(Check.pick({ name: true, workflow: true, status: true, required: true })),
  ignored: z.array(z.string()), expectedMissing: z.array(ExpectedCheck),
  eta: z.object({ seconds: z.number(), p90Seconds: z.number(), basis: z.string() }).nullable(), next: z.array(z.string()) });
```

- Duplicate re-run rows collapse to the latest attempt per (workflow, name) (§6).
- `cancelled` counts as red.

**Shared with main** (one definition, used by `ci why`, `ci wait`, `pr status` and `pr merge`):
- The comparison branch is the **repo default branch**, not the PR base, because stacked PRs exist (§4.1).
- The comparison run is the latest completed run of the same workflow file there, with event `push` and `head_sha ≠` the PR head.
- A failing PR job counts as **shared** only if that main run has a same-named job that concluded `failure`, and one of these holds:
  - `same-tests`: the PR's failing tests are non-empty and a subset of main's failing tests;
  - `same-step`: neither side yields test names, and the failing step name is equal.
- A job-name match alone never counts (§4.3, §7 #3246).

---

## 2. `pr create`

```
ghx pr create --input <pr.json|-> [-R owner/repo] [--dry-run]
ghx pr create --batch --input <prs.json|-> [-R owner/repo] [--dry-run]
```

Opens a PR from a validated object. The body is: description, trailer, footer, hidden block.

### 2.1 Input

```ts
const TestingItem = z.object({ kind: z.enum(["unit","integration","e2e","typecheck","lint","build","benchmark","manual"]),
  command: OneLine(200).optional(), cwd: z.string().max(120).regex(/^(?!\/)(?!.*\.\.)[\w@.\/-]+$/).optional(),
  steps: z.array(OneLine(160)).min(1).max(5).optional(), result: z.enum(["pass","fail","skipped","not-run"]),
  notes: OneLine(200).optional() }).strict();
const Refs = z.object({ stackedOn: PrRef.optional(), closes: z.array(IssueRef).max(10).optional(),
  related: z.array(PrRef).max(10).optional(), splitFrom: PrRef.optional(),
  supersedes: z.array(PrRef).max(10).optional(), reverts: PrRef.optional() }).strict();
const PrCreateInput = z.object({ title: z.string(), description: z.string(),
  testing: z.array(TestingItem).min(1).max(10), risk: Risk, riskNote: OneLine(160).optional(),
  components: z.array(Component).min(1).max(5), revertPolicy: RevertPolicy, revertNote: OneLine(200).optional(),
  revertWith: z.array(PrRef).max(10).optional(), base: z.string().min(1).max(255), head: z.string().min(1).max(255),
  draft: z.boolean().optional(), refs: Refs.optional() }).strict().superRefine(createRules);
```

**`createRules`.** All issues are reported together in `details.issues[]`.

| Path | Issue code | Rule |
|---|---|---|
| title | `title.format` | Must match `^(feat\|fix\|docs\|refactor\|perf\|test\|build\|ci\|chore\|revert\|style)(\(([a-z0-9][a-z0-9-]*)\))?(!)?: \S.*$`. Types are configurable. 71/73 titles already conform (§4.1) |
| title | `title.too_long` | ≤72 code points. 40/73 titles ran over; median 74 (§4.1) |
| title | `title.scope_missing` | Scope required (`title.scopeRequired`) |
| title | `title.multi_scope` | No comma in the scope (`codegen,vetra`, §4.1) |
| title | `title.scope_not_component` | Scope must be a config component |
| title | `title.scope_not_declared` | Scope must be in `input.components` |
| title | `title.pr_suffix` | No ` (#N)` suffix (§4.1) |
| title | `title.whitespace`, `title.trailing_period` | No stray whitespace, no trailing `.` |
| title | `title.revert_needs_ref` | `revert` requires `refs.reverts` |
| description | `description.lines` | 1–3 lines, no blank lines |
| description | `description.too_long` | ≤500 chars. The post-correction median was 568 including the ~65-char footer (§4.1) |
| description | `description.markdown_structure` | No headings, list markers, `>`, tables, fences, `<details` or `<!--`. Encodes the user's corrections (§4.1) |
| description | `description.footer` | No footer or `ghx:` marker; ghx adds both |
| testing | `testing.min_pass` | At least one item has `pass` (`create.requirePassingTest`) |
| testing[i] | `testing.command_required` / `testing.steps_required` | Non-manual items need a command; manual items need steps |
| testing[i] | `testing.not_rerunnable` | No absolute or home paths |
| testing[i] | `testing.compound_command` | No unquoted `\|`, `;`, `&&`, `>`, `<`, backtick or `$(`. Record the plain command and use `cwd` (§6) |
| testing[i] | `testing.notes_required` | `fail`, `skipped` and `not-run` need notes |
| riskNote | `risk.note_required` | `medium` and `high` need a note |
| risk | `risk.below_component_floor` | Risk ≥ the highest `minRisk` of the declared components |
| revertNote | `revert.note_required` | Needed for followup and forward-fix |
| revertWith | `revert.with_required` | `coordinated` needs at least one PR |
| components | `components.duplicate` | Unique |
| base | `base.equals_head` | base ≠ head |
| refs.stackedOn | `refs.stacked_on_default_base` | Not allowed on the default base |

**Network checks** (reported as `VALIDATION` issues):
- `components.undeclared_touched`: a changed path belongs to an undeclared component.
- `refs.stack_mismatch`: `stackedOn` disagrees with the PR whose head is the base.
- `refs.not_found`: a referenced PR or issue doesn't exist.

Network warnings:
- `COMPONENTS_UNUSED`: a declared component has no changed paths.
- `COMPONENTS_UNCHECKED`: over 300 files and no local checkout **[G-300]**.

### 2.2 Rendering

`render.mode` defaults to `trailer`:

```
{description}

Risk: {risk} · Components: {c1, c2} · Revert: {revertPolicy} · Tests: {P}/{N} pass ({kinds}){ · Stacked on #X}{ · Split from #Y}{ · Closes #Z…}

{render.footer, default "🤖 Generated with [Claude Code](https://claude.com/claude-code)"}

<!-- ghx:v1 {pr block} -->
```

- Results other than pass are appended, e.g. `2/3 pass, 1 not-run`.
- `Closes` and stack refs go in the visible trailer, so GitHub auto-closes and humans can read them (§4.1).
- `details` mode adds a collapsed "How to test" list.
- The body is asserted to be ≤65,536 chars.

### 2.3 Output

```ts
const PrCreateOutput = z.object({ ref: PrRef, number: z.number(), url: z.string().url(), title: z.string(), base: z.string(),
  head: z.object({ ref: z.string(), sha: Sha }), draft: z.boolean(), draftDerived: z.boolean(), stackedOn: PrRef.nullable(),
  blockId: z.string(), body: z.string(), next: z.array(z.string()), warnings: z.array(Warning) });
// --dry-run: { dryRun: true, ...without ref/number/url }
```

### 2.4 Extras

- **Draft.** By default a PR is a draft iff base ≠ default branch. An explicit `false` on a stacked base gets the warning `STACKED_NOT_DRAFT` (§4.1, §9.4).
- **Stack.** ghx auto-fills `stackedOn` from the open PR whose head is the base. If there is none, it warns `BASE_NOT_A_PR`.
- **Duplicates.** If the head already has an open PR, the command fails with `DUPLICATE_PR` and hints at `pr edit`. A closed PR on that head only produces a warning (§9.4).
- **`--batch`** replaces the shell function in §4.1 that produced a literal `$2` title:

```ts
const PrBatchInput = z.object({ defaults: PrCreateInput.innerType().partial().omit({ title: true, head: true }).optional(),
  items: z.array(PrCreateInput.innerType().partial()).min(1).max(20) }).strict();   // deepMerge(defaults,item), arrays replace
```

- Batch rules:
  - Heads must be unique.
  - Items are ordered topologically when one item's base is another item's head; a cycle is a `VALIDATION` error. Stacked items default to draft and get `stackedOn` filled in.
  - **Every item is validated, including network checks, before the first POST.** The batch stops at the first failure.
  - Output: `{created, failed, notAttempted}`. If some PRs were created before the failure, the code is `PARTIAL_FAILURE`.
  - A shared rationale goes in `defaults.refs.splitFrom`.

### 2.5 Errors

| Exit | Codes |
|---|---|
| 2 | `USAGE_INPUT_MISSING`, `USAGE_INPUT_JSON`, `VALIDATION` |
| 3 | `CONFIG_MISSING`, `CONFIG_INVALID` |
| 5 | `REPO_NOT_FOUND` |
| 6 | `DUPLICATE_PR` |
| 7 | `GH_FORBIDDEN`, `GH_FAILED`, `PARTIAL_FAILURE` |
| 9 | `BRANCH_MISSING`, `HEAD_NOT_PUSHED`, `NO_COMMITS` |

### 2.6 gh calls

1. **Config:** `.github/ghx.json`, local if the cwd is the target repo, otherwise `GET repos/o/r/contents/.github/ghx.json?ref=<base>` (§15, ask 1) **[G-CWD]**.
2. **zod**, no network. Fail fast with all issues.
3. **One `gh graphql` query:** viewer, default branch, viewerPermission, base and head refs, open and closed PRs for the head, parent PR for the base, and ref aliases.
4. **`gh api repos/o/r/compare/<base>...<head>`.** At 300 files, fall back to local `git diff --name-only` or warn **[G-300]**.
5. **Local head vs remote oid** when the cwd matches. On mismatch, warn `HEAD_DIFFERS_FROM_LOCAL` (§5.4).
6. **Render.** `--dry-run` stops here.
7. **`gh api -X POST repos/o/r/pulls --input -`.**
   - Not `gh pr create`, which may prompt, apply templates or push.
   - A 422 "exists" maps to `DUPLICATE_PR`.
   - On a transient error, re-check for an open PR before retrying; POST isn't idempotent.
8. **Read back** and assert the title and body are exact (title drift, §4.1).

---

## 3. `pr edit`

```
ghx pr edit <pr> --input <patch.json|-> [--discard-ui-edits] [--dry-run]
```

```ts
const PrEditInput = PrCreateInput.innerType().omit({ head: true }).partial().extend({ adopt: z.boolean().optional() }).strict()
  .refine(p => Object.keys(p).length > 0, "empty patch");
```

- **Merge.** `{...block, ...patch}`; arrays replace. The result is validated with the full `createRules` plus network checks, and `rev` is incremented.
- **`NO_BLOCK`** unless the patch has `adopt:true` and the full object.
- **`DESCRIPTION_DRIFT`** if the visible text was edited in the UI and the patch omits `description`. `--discard-ui-edits` overrides it.
- **`CONCURRENT_EDIT`** if `updatedAt` or the body hash changed before the PATCH.
- **`draft:false`** replaces `gh pr ready` (12 calls).
- **`base`** replaces `gh pr edit --base` (§3.2); warns `HAS_CHILDREN`.

Output: `{ref, rev, changed: ("title"|"body"|"base"|"draft")[], body, warnings}`.

| Exit | Codes |
|---|---|
| 2 | `VALIDATION` |
| 5 | `PR_NOT_FOUND` |
| 7 | `GH_FAILED` |
| 9 | `NO_BLOCK`, `DESCRIPTION_DRIFT`, `CONCURRENT_EDIT`, `PR_NOT_OPEN`, `BRANCH_MISSING` |

gh calls:
1. GraphQL snapshot.
2. Validate.
3. Re-read `updatedAt`.
4. `gh api -X PATCH repos/o/r/pulls/N --input -`.
5. GraphQL `markPullRequestReadyForReview` or `convertPullRequestToDraft`.
6. Read back.

---

## 4. `pr status`

```
ghx pr status <pr> [-R owner/repo] [--no-compare-main] [--no-wait-mergeable]
```

One object that answers: what is this PR, can it land, and what's left (§8a, §9.3).

### 4.1 Output

```ts
const PrMeta = z.object({ id: z.string(), rev: z.number(), gen: z.string(), risk: Risk.or(z.string()), riskNote: z.string().nullable(),
  components: z.array(z.string()), revertPolicy: RevertPolicy.or(z.string()), revertNote: z.string().nullable(), revertWith: z.array(PrRef),
  testing: z.array(TestingItem.passthrough()), refs: Refs.passthrough() });
const Violation = z.object({ code: z.string(), message: z.string(), overridable: z.boolean(), details: z.record(z.unknown()).optional() });
const StatusEvent = z.object({ id: z.string(), by: z.string(), at: Iso, commit: Sha.nullable(), note: z.string().nullable(), verified: z.boolean().nullable(), url: z.string() });
const Finding = z.object({ id: z.string(), reviewId: z.string(), severity: Severity.or(z.string()), path: z.string().nullable(),
  line: z.number().nullable(), endLine: z.number().nullable(), alsoAt: z.array(z.object({ path: z.string(), line: z.number() })),
  title: z.string(), body: z.string(), truncated: z.boolean(), inline: z.boolean(), commit: Sha, outdated: z.boolean(),
  status: FindingStatus, statusEvent: StatusEvent.nullable(), url: z.string() });
const Review = z.object({ id: z.string(), structured: z.boolean(), author: Author, verdict: Verdict.nullable(),
  githubState: z.enum(["APPROVED","CHANGES_REQUESTED","COMMENTED","DISMISSED","PENDING"]), verdictDowngraded: z.boolean(),
  submittedAt: Iso, commit: Sha, outdated: z.boolean(), summary: z.string(), truncated: z.boolean(), findingIds: z.array(z.string()), url: z.string() });
const Comment = z.object({ id: z.string(), source: z.enum(["issue","review","inline"]), author: Author, at: Iso, body: z.string(),
  truncated: z.boolean(), structured: z.boolean(), kind: z.enum(["note","precondition","status","supersede","resolve"]).nullable(),
  path: z.string().nullable(), line: z.number().nullable(), threadResolved: z.boolean().nullable(), inReplyTo: z.string().nullable(),
  edited: z.boolean(), blockError: z.string().nullable(), url: z.string() });
const BotItem = z.object({ id: z.string(), source: z.enum(["issue","review","inline"]), author: z.string(), at: Iso,
  marker: z.string().nullable(), summary: z.string(), path: z.string().nullable(), line: z.number().nullable(), url: z.string() });
const Condition = z.discriminatedUnion("type", [ z.object({ type: z.literal("pr-merged"), ref: PrRef }),
  z.object({ type: z.literal("release-includes"), ref: PrRef }), z.object({ type: z.literal("manual"), text: z.string() }) ]);
const Precondition = z.object({ id: z.string(), condition: Condition, status: PreconditionStatus, evidence: z.string(),
  declaredBy: z.string(), declaredAt: Iso, url: z.string(), override: StatusEvent.extend({ status: PreconditionStatus }).nullable() });
const MergeState = z.object({ mergeable: z.enum(["MERGEABLE","CONFLICTING","UNKNOWN"]), settled: z.boolean(),
  mergeStateStatus: z.enum(["BEHIND","BLOCKED","CLEAN","DIRTY","DRAFT","HAS_HOOKS","UNKNOWN","UNSTABLE"]),
  reviewDecision: z.enum(["APPROVED","CHANGES_REQUESTED","REVIEW_REQUIRED"]).nullable(), method: z.enum(["merge","squash","rebase"]),
  ready: z.boolean(), blockers: z.array(Violation), waivers: z.array(Violation), warnings: z.array(Violation),
  mergedAt: Iso.nullable(), mergeCommit: Sha.nullable() });
const Stack = z.object({ parent: z.object({ ref: PrRef, state: z.string(), draft: z.boolean(), headRef: z.string() }).nullable(),
  declaredParent: PrRef.nullable(), children: z.array(z.object({ ref: PrRef, state: z.string(), draft: z.boolean(), headRef: z.string() })),
  baseChanges: z.array(z.object({ from: z.string(), to: z.string(), at: Iso, automatic: z.boolean() })) });
const PrStatusOutput = z.object({ ref: PrRef, url: z.string(), number: z.number(), title: z.string(), author: Author,
  state: z.enum(["OPEN","CLOSED","MERGED"]), draft: z.boolean(), createdAt: Iso, updatedAt: Iso,
  base: z.object({ ref: z.string(), isDefault: z.boolean() }), head: z.object({ ref: z.string(), sha: Sha }),
  changes: z.object({ files: z.number(), additions: z.number(), deletions: z.number(), commits: z.number() }),
  description: z.object({ text: z.string(), structured: z.boolean(), drift: z.array(z.enum(["title","description","trailer"])) }),
  meta: PrMeta.nullable(), metaError: z.object({ code: z.string(), message: z.string() }).nullable(),
  merge: MergeState, ci: CiSummary,
  feedback: z.object({ reviews: z.array(Review), findings: z.array(Finding), comments: z.array(Comment), bots: z.array(BotItem),
    counts: z.object({ reviews: z.number(), findingsTotal: z.number(), findingsOpen: z.number(), comments: z.number(), bots: z.number(),
      unresolvedHumanThreads: z.number(), omitted: z.number() }) }),
  openFindings: z.array(z.string()), preconditions: z.array(Precondition), stack: Stack,
  warnings: z.array(Warning), fetchedAt: Iso });
```

**Folding rules:**
- **Each item is in exactly one list:** `reviews`, `findings`, `comments` (humans and ghx, including resolve events) or `bots`.
- **Description.** `description.text` is the visible prose. `meta` comes from the block. `drift` lists fields where the two disagree.
- **Unstructured items.** Items with no valid trusted block get `structured:false` and are never dropped (brief 7). A rejected block sets `blockError`.
- **Bots.** An item is a bot item if:
  - its `__typename` is Bot, or its login ends in `[bot]`;
  - its login is in `bots.logins`; or
  - it carries a marker from `bots.markers` (§8c4).

  Bot inline items keep their path and line (§8c3).
- **Merge fields.** `merge.*` uses the same policy engine as `pr merge` (§8), so `ready` answers §8a.
- **Truncation.**
  - Per-item caps: description 1,000, comment 500, finding 600, summary 400.
  - If the document is still over 16 KB, ghx drops resolved-finding bodies, then the oldest comment bodies, counts them in `omitted`, and adds a hint pointing to `pr feedback`.
  - The 01 spill is the safety net.

### 4.2 Errors

| Exit | Codes |
|---|---|
| 3 | `CONFIG_INVALID`. `CONFIG_MISSING` here is only a warning, plus blocker `CONFIG_MISSING` |
| 4 | `ENV_*` |
| 5 | `PR_NOT_FOUND`, `REPO_NOT_FOUND` |
| 7 | `GH_*` |

### 4.3 gh calls

All calls use the read-mode client, `gh graphql` and `gh api` GET only.

1. **Resolve the repo [G-CWD].**
2. **GraphQL Q1**, fetching in one query (paginated on `hasNextPage`):
   - PR fields;
   - `comments(first:100)`, `reviews(first:100)`;
   - `reviewThreads(first:100){isResolved isOutdated path line comments(first:50){… replyTo pullRequestReview}}`;
   - `timelineItems(BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT)` **[G-RETARGET]**;
   - `commits(last:1){commit{oid statusCheckRollup{contexts(first:100){CheckRun{databaseId … isRequired checkSuite{workflowRun{databaseId workflow{databaseId name}}}} StatusContext{…}}}}}`;
   - viewer, repo merge settings and default branch;
   - `rateLimit`.
3. **[G-SHA]** Assert rollup oid == `headRefOid`. On mismatch, re-query once; then warn `CI_SHA_MISMATCH` with state `pending`.
4. **[G-UNKNOWN]** Unless `--no-wait-mergeable`, re-query `mergeable` with backoff 1, 2, 3, 4, 5, 5 s (≤20 s). If it stays unknown, set `settled:false` and warn. If the head changes, restart once.
5. **GraphQL Q2:** parent, children and precondition-ref aliases. Verify `addressed` commits via `compare/<commit>...<head>` (≤10).
6. **Expected set and ETA** (§11.3, §11.6), from cache.
7. **Shared-with-main** for failing Actions checks, unless `--no-compare-main`. At most 5 jobs: `actions/jobs/{id}` and logs **[G-LOGS]**, plus the main run, jobs and logs.
8. **`release-includes`:** `releases/latest` plus `compare`.

A green PR costs 2 GraphQL calls. A red one costs about 3 REST calls per failing job (versus 5–8 calls in §8b).

---

## 5. `pr feedback`

```
ghx pr feedback <pr> [--open] [--source ghx|human|bot] [--since <iso|sha>] [--include-outdated]
```

The full feedback from all three sources (§8b).

| Flag | Keeps |
|---|---|
| `--open` | Open findings, unresolved human threads, unmet preconditions, and each reviewer's latest non-dismissed `CHANGES_REQUESTED` |
| `--since <sha>` | Items newer than that commit's date |
| `--include-outdated` | Outdated items too; by default they are dropped only under `--open` |

Output: `{ref, headSha, feedback, openFindings, preconditions, artifactPath, warnings}`. Bodies are capped at 2,000 chars inline, and the full JSON always goes to `artifactPath`. Errors are the same as `pr status`.

---

## 6. Exit codes and error catalogue

### 6.1 Exit-code table

This table starts from 01's provisional table and adds 9 STATE plus `ci wait` outcomes in the reserved 10–19 range.

| Exit | Class | Meaning | Agent action |
|---:|---|---|---|
| 0 | OK | Success. A read that reports red still succeeds | — |
| 1 | INTERNAL | Bug, output contract violation, or read-mode mutation | Report it |
| 2 | USAGE | Unknown command or flag, bad selector, input missing or not JSON, or `VALIDATION` (all issues listed) | Fix it as the hint says |
| 3 | CONFIG | `.github/ghx.json` missing or invalid | Fix the config |
| 4 | ENV | gh missing, too old, or unauthenticated | A human fixes it |
| 5 | NOT_FOUND | PR, repo, run, id or ref missing, including a cwd mismatch | Fix the selector or `--repo` |
| 6 | POLICY | A ghx rule refused a write. Overridable codes are listed | Ask the user, or `--override CODE --reason` |
| 7 | GH_FAILED | gh or API failure after retries, permission, rate limit, or a partial batch | Retry or fix access |
| 8 | TIMEOUT | Deadline exceeded. For `ci wait`: budget used up (`outcome:"timeout"`, including `--if-eta-under`) | Background with `--max` |
| 9 | STATE | GitHub state forbids it now: head moved, conflict, CI pending, branch missing, concurrent edit | Change state, then retry |
| 10 | CI_RED | `ci wait`: a considered check failed and isn't shared with main | Read the diagnosis; fix it or `ci rerun --flaky` |
| 11 | CI_RED_SHARED | `ci wait`, any mode: red, but every failure is shared with main (§1.5). Distinct because the user's rule makes it mergeable (§4.3) | Go to `pr merge` (waived) |
| 12 | SUPERSEDED | `ci wait`: head moved (with `--on-head-change stop`), or the PR closed or merged | Re-read the state |
| 13 | NO_CHECKS | `ci wait`: nothing registered within the grace period. This is not green (§3.1, 11 cases) | Check triggers, or `ci retrigger` |
| 130/143 | INTERRUPTED | SIGINT or SIGTERM. `ci wait` returns `outcome:"interrupted"` when it can | — |

When `ci wait` watches several targets, the aggregate exit code is the first that applies: 10 > 13 > 12 > 8 > 11 > 0.

### 6.2 Error catalogue

`details` is `null` when there's nothing to say.

| Code | Exit | Example |
|---|---:|---|
| `USAGE_UNKNOWN_COMMAND` | 2 | `{"error":{"code":"USAGE_UNKNOWN_COMMAND","message":"'ghx pr view' is not a ghx command.","hint":"Use: ghx pr status 3198 -R powerhouse-inc/powerhouse (state, mergeable, CI for the head SHA and feedback in one object).","details":{"suggestion":["ghx","pr","status","3198","-R","powerhouse-inc/powerhouse"]}}}` (variants in §10) |
| `USAGE_UNKNOWN_FLAG` | 2 | `{"error":{"code":"USAGE_UNKNOWN_FLAG","message":"'ghx pr status' has no flag '--json'.","hint":"Output is a fixed schema; run 'ghx pr status --schema' to see its fields.","details":{"flag":"--json"}}}` |
| `USAGE_BAD_SELECTOR` | 2 | `{"error":{"code":"USAGE_BAD_SELECTOR","message":"'pr-3198' is not a PR selector.","hint":"Use 3198, #3198, powerhouse-inc/powerhouse#3198 or a PR URL.","details":null}}` |
| `USAGE_INPUT_MISSING` | 2 | `{"error":{"code":"USAGE_INPUT_MISSING","message":"ghx pr create needs JSON input and --input was not given.","hint":"Write the JSON to a file with your file tool, then run: ghx pr create --input pr.json (or --input - to read stdin).","details":null}}` |
| `USAGE_INPUT_JSON` | 2 | `{"error":{"code":"USAGE_INPUT_JSON","message":"pr.json is not valid JSON: Unexpected token } at line 9, column 3.","hint":"Fix the JSON in pr.json; do not build it with shell interpolation.","details":{"line":9,"column":3}}}` |
| `VALIDATION` | 2 | `{"error":{"code":"VALIDATION","message":"3 input issues.","hint":"title is 81 chars (max 72): shorten the subject; move detail into description.","details":{"issues":[{"path":"title","code":"title.too_long","message":"81 > 72"},{"path":"description","code":"description.markdown_structure","message":"line 2 starts with '- '"},{"path":"testing[0]","code":"testing.compound_command","message":"unquoted '|' in command; use cwd and record the plain command"}]}}}` |
| `CONFIG_MISSING` | 3 | `{"error":{"code":"CONFIG_MISSING","message":"powerhouse-inc/powerhouse has no .github/ghx.json at main.","hint":"Add .github/ghx.json with at least {\"components\":[…]}; run 'ghx schema config' for the format.","details":{"repo":"powerhouse-inc/powerhouse"}}}` |
| `CONFIG_INVALID` | 3 | `{"error":{"code":"CONFIG_INVALID","message":".github/ghx.json: merge.method 'squash-only' is not one of merge|squash|rebase.","hint":"Fix .github/ghx.json at merge.method.","details":{"issues":[{"path":"merge.method","message":"invalid enum"}]}}}` |
| `ENV_GH_MISSING` | 4 | `{"error":{"code":"ENV_GH_MISSING","message":"gh not found on PATH.","hint":"Install GitHub CLI and run 'gh auth login'; 'ghx doctor' checks the setup.","details":null}}` (use 01's ENV code names) |
| `ENV_GH_AUTH` | 4 | `{"error":{"code":"ENV_GH_AUTH","message":"gh is not authenticated for github.com.","hint":"Run 'gh auth login' (a human must do this).","details":null}}` |
| `PR_NOT_FOUND` | 5 | `{"error":{"code":"PR_NOT_FOUND","message":"No PR #3258 in thegoldenmule/sektar (repo resolved from cwd).","hint":"Pass the repo: ghx pr status powerhouse-inc/powerhouse#3258 (or -R owner/repo).","details":{"repo":"thegoldenmule/sektar","repoSource":"cwd"}}}` |
| `REPO_NOT_FOUND` | 5 | `{"error":{"code":"REPO_NOT_FOUND","message":"Could not determine a repo: cwd is not a git checkout.","hint":"Pass -R owner/repo or an owner/repo#N selector.","details":null}}` |
| `RUN_NOT_FOUND` | 5 | `{"error":{"code":"RUN_NOT_FOUND","message":"Run 123 not found in powerhouse-inc/powerhouse.","hint":"Check the id, or use the PR: ghx ci why <pr>.","details":null}}` |
| `ID_NOT_FOUND` | 5 | `{"error":{"code":"ID_NOT_FOUND","message":"No finding or precondition f_zzzzzz on #3301.","hint":"List ids: ghx pr feedback powerhouse-inc/powerhouse#3301 --open","details":{"known":["f_h4x8pz","f_n2c6rv"]}}}` |
| `REF_NOT_FOUND` | 5 | `{"error":{"code":"REF_NOT_FOUND","message":"Precondition ref #9999 does not exist.","hint":"Use an existing PR ref (owner/repo#N for cross-repo).","details":null}}` |
| `DUPLICATE_PR` | 6 | `{"error":{"code":"DUPLICATE_PR","message":"fix/reactor-bind-document-id already has open PR powerhouse-inc/powerhouse#3301.","hint":"Update it instead: ghx pr edit powerhouse-inc/powerhouse#3301 --input patch.json","details":{"existing":"powerhouse-inc/powerhouse#3301"}}}` |
| `MERGE_BLOCKED` | 6/9 | See §8.4 |
| `AUTHOR_NOT_VIEWER` | 6 | `{"error":{"code":"AUTHOR_NOT_VIEWER","message":"#3169 is authored by other-dev, not you (thegoldenmule).","hint":"Only act on your own PRs; if the user asked for this one, add --override AUTHOR_NOT_VIEWER --reason \"<who asked>\".","details":{"author":"other-dev"}}}` |
| `RERUN_LIMIT` | 6 | `{"error":{"code":"RERUN_LIMIT","message":"Run 37951014406 is on attempt 3 (limit 3).","hint":"Diagnose instead: ghx ci why powerhouse-inc/powerhouse#3187. Override with --override RERUN_LIMIT --reason only if the user approved.","details":{"runId":37951014406,"attempt":3}}}` |
| `GH_FAILED` | 7 | `{"error":{"code":"GH_FAILED","message":"POST /pulls failed after 3 attempts: HTTP 502.","hint":"Retry; ghx re-checks for a created PR before re-posting.","details":{"status":502}}}` |
| `GH_FORBIDDEN` | 7 | `{"error":{"code":"GH_FORBIDDEN","message":"You lack push permission on powerhouse-inc/powerhouse (viewerPermission READ).","hint":"Use a fork head (owner:branch) or ask for access.","details":null}}` |
| `GH_RATE_LIMITED` | 7 | `{"error":{"code":"GH_RATE_LIMITED","message":"GraphQL rate limit exhausted; resets 09:47:00Z.","hint":"Retry after the reset.","details":{"resetAt":"2026-10-22T09:47:00Z"}}}` |
| `REOPEN_FAILED` | 7 | `{"error":{"code":"REOPEN_FAILED","message":"#3187 was closed to retrigger CI but reopening failed 3 times.","hint":"Ask the user to reopen #3187 in the GitHub UI now.","details":{"closedAt":"2026-10-21T15:47:30Z"}}}` |
| `REVIEW_REJECTED` | 7 | `{"error":{"code":"REVIEW_REJECTED","message":"GitHub rejected the review: 'Line could not be resolved' (finding 2).","hint":"Re-run; ghx recomputes diff hunks against the current head.","details":{"findingIndex":1}}}` |
| `PARTIAL_FAILURE` | 7 | `{"error":{"code":"PARTIAL_FAILURE","message":"Batch created 3 of 8 PRs; item 3 failed with HEAD_NOT_PUSHED.","hint":"Push fix/y and re-run the batch with items 3–7 only.","details":{"created":["powerhouse-inc/powerhouse#3171","powerhouse-inc/powerhouse#3172","powerhouse-inc/powerhouse#3173"],"failed":{"index":3},"notAttempted":[4,5,6,7]}}}` |
| `TIMEOUT` | 8 | `{"error":{"code":"TIMEOUT","message":"pr merge exceeded its 2m deadline while waiting for mergeability.","hint":"Re-run; if it repeats, check GitHub status.","details":{"deadlineMs":120000}}}` (`ci wait` returns a summary instead) |
| `HEAD_MOVED` | 9 | `{"error":{"code":"HEAD_MOVED","message":"Head is 9f2c4e1, expected 4b1e7d2.","hint":"Re-check the new head: ghx pr status powerhouse-inc/powerhouse#3301, then retry with --expect-head 9f2c4e1.","details":{"expected":"4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47","actual":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d"}}}` |
| `PR_NOT_OPEN` | 9 | `{"error":{"code":"PR_NOT_OPEN","message":"#3211 is CLOSED.","hint":"Reopen it in the UI or create a new PR.","details":{"state":"CLOSED"}}}` |
| `BRANCH_MISSING` | 9 | `{"error":{"code":"BRANCH_MISSING","message":"Base branch 'feat/reactor-worker' does not exist on powerhouse-inc/powerhouse.","hint":"Check the name, or create and push the base first.","details":{"branch":"feat/reactor-worker"}}}` |
| `HEAD_NOT_PUSHED` | 9 | `{"error":{"code":"HEAD_NOT_PUSHED","message":"Branch 'fix/x' is not on the remote.","hint":"git push -u origin fix/x","details":{"branch":"fix/x"}}}` |
| `NO_COMMITS` | 9 | `{"error":{"code":"NO_COMMITS","message":"fix/x has no commits ahead of main.","hint":"Commit and push your change first.","details":{"aheadBy":0}}}` |
| `NO_BLOCK` | 9 | `{"error":{"code":"NO_BLOCK","message":"#3088 has no ghx metadata block.","hint":"Adopt it: pass the full object with \"adopt\": true.","details":null}}` |
| `DESCRIPTION_DRIFT` | 9 | `{"error":{"code":"DESCRIPTION_DRIFT","message":"The visible description was edited outside ghx.","hint":"Include \"description\" in the patch (current visible text is in details), or pass --discard-ui-edits.","details":{"visible":"The supergraph SSE schema …"}}}` |
| `CONCURRENT_EDIT` | 9 | `{"error":{"code":"CONCURRENT_EDIT","message":"#3301 changed since it was read (updatedAt 16:30:40 → 16:31:02).","hint":"Re-run the same command; it re-reads the PR.","details":null}}` |
| `RUN_IN_PROGRESS` | 9 | `{"error":{"code":"RUN_IN_PROGRESS","message":"All failed runs for 9f2c4e1 are still running; GitHub rejects reruns until a run completes.","hint":"ghx ci wait powerhouse-inc/powerhouse#3301 --until settled, then ghx ci rerun.","details":{"runs":[37948190914]}}}` |
| `NO_FAILED_RUNS` | 9 | `{"error":{"code":"NO_FAILED_RUNS","message":"No failed Actions runs for head 9f2c4e1.","hint":"Nothing to rerun. If CI never started after a base change, use ghx ci retrigger.","details":{"ciState":"green"}}}` |
| `NO_FLAKY_CANDIDATES` | 9 | `{"error":{"code":"NO_FLAKY_CANDIDATES","message":"No failed job on 9f2c4e1 looks flaky.","hint":"Treat it as a real failure: ghx ci why powerhouse-inc/powerhouse#3301","details":{"failing":["Test Reactor (shard 1/3)"]}}}` |
| `HEAD_BRANCH_MISSING` | 9 | `{"error":{"code":"HEAD_BRANCH_MISSING","message":"Head branch 'fix/x' no longer exists, so a closed PR could not be reopened.","hint":"Push the branch again before retriggering.","details":null}}` |
| `INTERNAL` | 1 | `{"error":{"code":"INTERNAL","message":"Unexpected: Cannot read properties of undefined.","hint":"Report this with the stack file.","details":{"stackPath":"/…/ghx/github.com/powerhouse-inc/powerhouse/internal/stack-1729588500.txt"}}}` |

- The merge violation codes (§8.2) appear in `MERGE_BLOCKED.details.plan.blockers`.
- 01's `INTERNAL_OUTPUT_CONTRACT`, `INTERNAL_READ_MUTATION` and `INTERRUPTED` are used unchanged.

---

## 7. Feedback writes

### 7.1 `pr comment`

```
ghx pr comment <pr> --input <c.json|-> [--close] [--dry-run]
```

Typed coordination comments. Preconditions are enforced by `pr merge` (§8c5). `--close` covers the 4 `pr close --comment` calls (§7).

```ts
const Body = (maxChars: number, maxLines: number) => z.string().trim().min(1).max(maxChars)
  .refine(s => s.split("\n").length <= maxLines).refine(s => !s.includes("<!-- ghx:"));
const PrCommentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), body: Body(1500, 15) }).strict(),
  z.object({ kind: z.literal("precondition"), condition: Condition, body: Body(500, 3).optional() }).strict(),
  z.object({ kind: z.literal("status"), state: z.enum(["waiting","blocked","ready","rebased","split"]), body: Body(500, 3), refs: z.array(PrRef).max(10).optional() }).strict(),
  z.object({ kind: z.literal("supersede"), by: PrRef, body: Body(500, 3).optional() }).strict(),
]);
```

- **Rules:**
  - Refs must exist and must not point at this PR.
  - `--close` is refused with a precondition.
  - `supersede` without `--close` warns `SUPERSEDED_STILL_OPEN`.
  - A `manual` precondition stays `unknown` until `pr resolve <c_id> --status met --note …`.
- **Rendering:** "**Merge precondition:** merge only after #3184 is merged.", "Superseded by #3250.", or "**Status:** rebased. {body}", followed by the block.
- **Output:** `{ref, id, kind, commentId, url, closed, precondition: {status, evidence} | null, warnings}`.

| Exit | Codes |
|---|---|
| 2 | `VALIDATION` |
| 5 | `PR_NOT_FOUND`, `REF_NOT_FOUND` |
| 7 | `GH_*` |
| 9 | `PR_NOT_OPEN` |

gh calls:
1. GraphQL: state and refs.
2. `POST issues/N/comments`.
3. Optionally `PATCH pulls/N {state:"closed"}`.

### 7.2 `pr review`

```
ghx pr review <pr> --input <review.json|-> [--expect-head <sha>] [--dry-run]
```

A real review with a verdict, inline findings and blocks. `gh pr review` was used 0 times (§8d).

```ts
const Location = z.object({ path: RepoPath, line: z.number().int().positive() });
const FindingInput = z.object({ severity: Severity, path: RepoPath, line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(), side: z.enum(["RIGHT","LEFT"]).default("RIGHT"),
  alsoAt: z.array(Location).max(10).default([]), title: OneLine(100), body: Body(2000, 30),
  suggestion: z.string().max(2000).optional() }).strict();
const PrReviewInput = z.object({ verdict: Verdict, summary: Body(400, 3), scope: OneLine(200).optional(),
  findings: z.array(FindingInput).max(50).default([]) }).strict().superRefine(reviewRules);
```

- **`reviewRules`:**
  - `review.approve_with_high`: an approve can't carry a high finding.
  - `review.request_changes_without_findings`: request-changes needs at least one finding.
  - `finding.range`: `endLine` ≥ `line`.
  - `finding.duplicate`: no repeated (path, line, title).
  - `finding.path_not_in_pr` (network): the path must be in the diff.
- **Inline placement.** A finding goes inline only if its range is inside a diff hunk (from `pulls/N/files`). Otherwise it goes in the review body with its own block and warning `FINDING_NOT_INLINE`. Files with no patch are body-only.
- **Self-review.** GitHub returns 422 for APPROVE or REQUEST_CHANGES on your own PR. ghx posts `COMMENT`, keeps the verdict in the block, and sets `verdictDowngraded:true` with warning `VERDICT_DOWNGRADED`. This is the common case under the user's token (§7; Pushback).
- **Pin.** `commit_id` = `--expect-head` or the current head; a mismatch is `HEAD_MOVED` **[G-SHA]**.

Review body:

```
**ghx review** · {verdict} · {n} findings ({h} high, {m} medium, {l} low)

{summary}

Scope: {scope}

1. **[high]** `{path}:{line}` {title}

<!-- ghx:v1 {review block} -->
{<!-- ghx:v1 {finding block} --> per body-only finding}
```

Inline comment:

```
**[{severity}] {title}**

{body}

Also at: `{path}:{line}`, …

<!-- ghx:v1 {finding block} -->
```

Output: `{ref, id, githubReviewId, url, verdict, postedAs, verdictDowngraded, commit, findings: [{id, severity, inline, commentId, url}], warnings}`.

| Exit | Codes |
|---|---|
| 2 | `VALIDATION` |
| 5 | `PR_NOT_FOUND` |
| 7 | `REVIEW_REJECTED`, `GH_*` |
| 9 | `HEAD_MOVED`, `PR_NOT_OPEN` |

gh calls:
1. GraphQL: head, author, viewer.
2. `GET pulls/N/files`, paginated, ≤3,000 files.
3. `POST pulls/N/reviews --input -` in one atomic call. There is no relocation retry.
4. `GET pulls/N/reviews/{id}/comments` to map ids.

### 7.3 `pr resolve`

```
ghx pr resolve <pr> <id> [<id>…] --status addressed|wontfix|deferred|open|met|withdrawn|unmet
               [--commit <sha>] [--note "<≤200 chars, one line>"] [--tracking <issue-ref>] [--dry-run]
```

Appends status events (§9.4) and implements §9.6. `--note` is the one prose flag: one line, ≤200 chars.

| Rule | Failure |
|---|---|
| Each id exists and is trusted | `ID_NOT_FOUND` (5) |
| Findings take addressed, wontfix, deferred or open. Preconditions take met, withdrawn or unmet | `VALIDATION` |
| `addressed` needs a `--commit` reachable from the head and not from the base | `resolve.commit_not_in_pr` |
| wontfix, deferred, met and withdrawn need `--note` | `resolve.note_required` |
| Setting the status the item already has | Warning `ALREADY_IN_STATUS`, exit 0 |

Writes:
- **Inline findings:** a thread reply via `POST pulls/N/comments/{id}/replies`, then a best-effort GraphQL `resolveReviewThread` or `unresolveReviewThread`. If that fails, warn `THREAD_RESOLVE_FAILED`.
- **Everything else:** one issue comment.

Output: `{ref, events: [{id, from, to, commentId, url, threadResolved}], warnings}`.

---

## 8. `pr merge` (policy)

```
ghx pr merge <pr> [--expect-head <sha>] [--method merge|squash|rebase]
             [--override CODE[,CODE…] --reason "<≤200 chars>"] [--delete-branch] [--dry-run]
```

Merges only when policy allows. The merge is pinned to the evaluated head and the result is verified. This replaces §5.3. A squash uses the title `{PR title} (#N)` with the description as the commit message.

### 8.1 Flow and gh calls

1. **Resolve and load config.** No config means `CONFIG_MISSING` (3).
2. **Snapshot** with the `pr status` pipeline; the mergeable bound is 30 s **[G-UNKNOWN]**.
3. **Pin `H = headRefOid`.** A mismatched `--expect-head` is `HEAD_MOVED` **[G-SHA]**.
4. **Already merged:** if `--expect-head` is absent or matches, return `{merged:true, alreadyMerged:true}` with exit 0 (#3211).
5. **Checks and overrides.**
   - An override code must be overridable and actually violated. An unknown code is `VALIDATION`; an unused one warns `OVERRIDE_UNUSED`.
   - `--reason` is required with any override.
6. **Dry run or blockers:** emit the plan (§8.4).
7. **Merge** with `gh api -X PUT repos/o/r/pulls/N/merge --input -` and `{sha: H, merge_method}`.
   - Why REST: `sha` pins the head server-side, 405 and 409 are distinct, and local branches are never touched (§7).
   - 405: re-read the PR. `DIRTY` → `MERGE_CONFLICT`; `BLOCKED` → `BLOCKED_BY_PROTECTION`.
   - Transient error (#3214): re-read the PR. If it's merged and its head oid still equals `H`, report success with `recoveredFromTransient:true`; otherwise retry once.
8. **Verify** by polling `GET pulls/N` until merged (≤10 s).
9. **Delete the branch** only if `--delete-branch` or `merge.deleteBranch` is set, the branch is same-repo, and no PR uses it as base. ghx deletes the remote ref only, and children retarget **[G-RETARGET]**.
10. **Output** with `next: ["ghx ci wait branch:<default>@<mergeCommit>"]`.

### 8.2 Checks

All checks run, and all violations are reported together.

| # | Code | Class | Overridable | Rule | Evidence |
|---|---|---|---|---|---|
| 1 | `PR_NOT_OPEN` | state | no | PR is OPEN | |
| 2 | `PR_DRAFT` | state | no | Not a draft (hint: `pr edit {"draft":false}`) | |
| 3 | `HEAD_MOVED` | state | no | `--expect-head` matches | §4.3 |
| 4 | `AUTHOR_NOT_VIEWER` | policy | yes | Author is the viewer (`merge.requireOwnPr`) | §4.3 |
| 5 | `METHOD_NOT_ALLOWED` | policy | no (config) | `merge.method` (default `merge`). Squash or rebase needs `--method`, an `allowedMethods` entry, and the repo setting | §4.3, §7 |
| 6 | `MERGEABLE_UNKNOWN` | state | no | Still UNKNOWN after 30 s | §5.2 |
| 7 | `MERGE_CONFLICT` | state | no | PR is CONFLICTING. The hint gives the exact fetch, merge and push commands | §3.3 |
| 8 | `BEHIND_BASE` | state | no | `mergeStateStatus` is BEHIND | |
| 9 | `BLOCKED_BY_PROTECTION` | state | no | BLOCKED for any other reason | |
| 10a | `CI_PENDING` | state | no | Checks pending, or a required or config check missing (§11.3). Hint: `ci wait --until mergeable` | §5.2 |
| 10b | `CI_NO_CHECKS` | state | yes | Nothing reported. Passes automatically if the expected set is empty and either the repo has no workflows (`GET actions/workflows` total 0) or `ci.none` is true | |
| 11 | `CI_RED` | policy | yes | Waived automatically when every failure is shared with main and `merge.sharedRed` is `tests` (default) or `step` | §4.3, §7 #3246 |
| 12 | `KEY_STEP_SKIPPED` | policy | yes | A `ci.keySteps` step was skipped in a green job | §6 |
| 13 | `CHANGES_REQUESTED` | policy | yes | A human's latest non-dismissed `CHANGES_REQUESTED` | |
| 14 | `FINDINGS_OPEN` | policy | yes | No open finding at or above `merge.blockOnSeverity` (default high; unknown severity counts as high). Lower severities only warn | §8c |
| 15 | `PRECONDITION_UNMET` | policy | yes | Every precondition is met or withdrawn. `unknown` blocks | §8c5 |
| — | warnings | | | Unresolved human threads, lower-severity findings, a base change in the last 24 h, children, `high` risk | |

### 8.3 Output

```ts
const PlanCheck = z.object({ code: z.string(), status: z.enum(["pass","fail","waived","overridden","warn","skipped"]), message: z.string() });
const MergePlan = z.object({ ref: PrRef, headSha: Sha, method: z.enum(["merge","squash","rebase"]), allowed: z.boolean(),
  checks: z.array(PlanCheck), blockers: z.array(Violation), waivers: z.array(Violation),
  overrides: z.array(z.object({ code: z.string(), reason: z.string() })),
  request: z.object({ method: z.literal("PUT"), path: z.string(), body: z.record(z.unknown()) }) });
const PrMergeOutput = z.object({ ref: PrRef, merged: z.literal(true), alreadyMerged: z.boolean(), recoveredFromTransient: z.boolean(),
  method: z.string(), headSha: Sha, mergeCommit: Sha, mergedAt: Iso, deletedBranch: z.boolean(),
  children: z.array(z.object({ ref: PrRef, base: z.string() })), plan: MergePlan, next: z.array(z.string()), warnings: z.array(Warning) });
// --dry-run allowed: { dryRun: true, wouldMerge: true, plan } (exit 0)
```

### 8.4 Dry-run and refusal

The code is `MERGE_BLOCKED`. The exit code is **6** if any blocker is policy-class, otherwise **9**.

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

01's codec owns the wire format. This section owns the payloads and rules.

### 9.1 Encoding

- **Format:** `<!-- ghx:v<MAJOR> <json> -->` on one line.
- **Escaping:** `JSON.stringify`, then `<`, `>` and `&` become `<`, `>` and `&`. `-->` can never appear inside the JSON, so the regex `/<!-- ghx:v(\d+) ([^]*?) -->/g` is unambiguous. For example, `a --> b` is stored as `"a --> b"`.
- **Multiple blocks** per body are allowed, kept in order.
- **Size:** bodies are capped at 65,536 chars; the `pr` block stays under about 8 KB.
- **Common fields:** `t`, `id`, `gen` (`"ghx/<semver>"`). The version lives only in the marker.

### 9.2 Types (strict on write)

```ts
const PrBlock = z.object({ t: z.literal("pr"), id, gen, rev: z.number().int().min(1), title, description, testing, risk, riskNote?,
  components, revertPolicy, revertNote?, revertWith?, refs? }).strict();   // PR body; one (extra ⇒ first valid + DUPLICATE_BLOCK)
const ReviewBlock = z.object({ t: z.literal("review"), id, gen, verdict: Verdict, summary, scope?, commit: Sha, findings: z.array(z.string()) }).strict();
const FindingBlock = z.object({ t: z.literal("finding"), id, gen, review: z.string(), severity: Severity, path: RepoPath, line, endLine?,
  side, alsoAt, title, body, suggestion?, commit: Sha }).strict();         // no status field: initially open
const CommentBlock = z.object({ t: z.literal("comment"), id, gen }).and(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note") }),
  z.object({ kind: z.literal("precondition"), condition: Condition }),
  z.object({ kind: z.literal("status"), state, refs? }),
  z.object({ kind: z.literal("supersede"), by: PrRef }),
  z.object({ kind: z.literal("resolve"), targets: z.array(z.object({ id: z.string(), status: FindingStatus.or(PreconditionStatus),
    commit: Sha.optional(), note: z.string().max(200).optional(), tracking: IssueRef.optional() })).min(1).max(50) }) ]));
```

### 9.3 Versioning and forward compatibility

- **v1 changes are additive only:** optional fields, enum values, new `t` or `kind`. A breaking change means v2.
- **Writers** are strict.
- **Readers** are lenient: `.passthrough()`, and enums accept `.or(z.string())`.
  - Unknown fields are ignored.
  - An unknown enum value is kept and warned as `UNKNOWN_ENUM`. **Policy fails closed:** unknown severity or risk counts as high, and an unknown condition counts as `unknown`.
  - An unknown `t` or `kind` gives structured with `kind:null`, is ignored by policy, and warns `UNKNOWN_BLOCK_TYPE`.
- **`ghx:v2` blocks** read by a v1 reader give `structured:false`, `blockError: "newer schema v2"` and the warning `SCHEMA_NEWER`.
- **Invalid blocks** give `structured:false` plus `blockError` and are never dropped.

### 9.4 Status: append-only events (chosen over editing)

Status is folded from `comment{kind:"resolve"}` events, ordered by `createdAt` then `databaseId`. The last valid event wins; with no events, the status is open.

Why events instead of editing the finding:
1. Comment PATCH has no `If-Match`, so concurrent editors lose updates.
2. Events keep an audit trail that today lives in `TRACKER.md` files (§8c).
3. Thread replies are where humans look, and ghx also sets GitHub's resolved flag.
4. Nobody edits anyone else's comment.

**Who may change what.** Every write uses the user's token (§7), so identity can't be checked.
- **Trust gate.** A block counts only if `authorAssociation` is in `trust.associations` (default OWNER, MEMBER, COLLABORATOR) or the author is in `trust.bots`. Otherwise: `structured:false` plus `UNTRUSTED_BLOCK`. This stops forged met or addressed events.
- **Facts.**
  - `addressed` needs a commit reachable from the head and not from the base; reads re-verify this. If a force-push drops the commit: `verified:false`, the status reverts to open, and ghx warns `EVENT_COMMIT_UNREACHABLE`.
  - wontfix, deferred, met and withdrawn need notes.
  - `open` is always allowed.
- **Edits.**
  - ghx never edits or deletes comments after posting. The only exception is `pr edit` rewriting the `pr` block (rev+1).
  - A valid UI edit is honoured and flagged (`edited` or `drift`). A broken one gives `structured:false`.
  - A deleted event leaves the fold.

---

## 10. Passthrough policy

**Decision: no passthrough.** ghx never runs arbitrary gh subcommands. Unknown commands get `USAGE_UNKNOWN_COMMAND` (exit 2) with one of these hints:

| Invocation | Hint |
|---|---|
| A gh command that ghx replaces (per `replaces`): `pr view`/`pr checks` → `pr status`/`ci wait`; `run view --log*` → `ci why`; `run watch`, `pr checks --watch` → `ci wait`; `run rerun` → `ci rerun`; `pr ready` → `pr edit {"draft":false}`; `pr close` → `pr comment --close` | The exact ghx argv in `details.suggestion` |
| An unwrapped gh read (`pr diff`, `pr list`, `issue view`, `run list`, `api` GET, …) | "ghx does not wrap this read; run it with gh directly: `gh pr diff 3198 -R powerhouse-inc/powerhouse`" (repo filled in) |
| An unwrapped gh write (`issue create`, `release create`, `api -X POST`, …) | "ghx does not perform this write, and raw gh writes may be denied by policy; ask the user." |
| Anything else | Edit-distance suggestions (01 default) |

Why:
- **It matches the confirmed steering.** `permissions.deny` blocks raw gh PR writes, while raw reads stay allowed under a fail-open hook that nudges toward ghx. A passthrough would only add a route around the deny rules and another place where mutations could leak.
- **No loop with the hook.** The hook fires only on commands in `replaces`, and ghx points to raw gh only for commands nothing replaces.
- **Reads stay read-only.** They use 01's allowlist guard. Passthrough would need a bigger, separately audited exec path.
- **The risk is in writes.** There were 0 `gh api` mutations (§2.4) and no reckless writes (§7); policy drift lives in writes. The harness refusals came from compound pipelines, not plain gh reads (§3.2).
- **Almost no new code:** 01's `onUnknown` plus `replaces` (§15, ask 3).
- **Trade-off:** unwrapped reads keep gh's output format. A structured `pr diff` with a fallback above 300 files (§9.10) is the top v1.1 candidate.

---

## 11. `ci wait`: the CI watcher

```
ghx ci wait <target> [<target>…] [--until settled|first-failure|mergeable] [--any]
            [--timeout <dur> | --max <dur>] [--if-eta-under <dur>]
            [--grace <dur>] [--expect-grace <dur>] [--on-head-change restart|stop|stay]
            [--check <glob>]… [--no-diagnose] [--no-compare-main]
```

A target is a PR selector, `branch:<name>` or `branch:<name>@<sha>`.

The command blocks, or streams in the background, until CI for a bound SHA reaches the requested state. It emits one NDJSON line per transition and ends with a self-contained summary that includes the diagnosis. It replaces 232 sleep loops, 44 Monitor scripts, 41 `--watch` calls, 74 perl alarms and 98 background runs (§5.2, §9.2). It is a pure read, using 01's stream mode and the read-only client.

### 11.1 Agent-harness fit

The two budget flags are mutually exclusive (`VALIDATION`). Both set 01's `ctx.deadline`; the spec is `timeout: {defaultMs: 8m, maxMs: 6h}`.

| Flag | Default | Range | Use |
|---|---|---|---|
| `--timeout` | **8m** | 10s–9m30s | Blocking call inside the Bash tool's 10-minute cap. Values over 9m30s are refused with "use `--max` and run in background", not accepted only to be killed |
| `--max` | — | 1m–6h | Background run under a line monitor. Turns on 01's 60 s heartbeat and a 30 s interval floor |

- **Why 8m:** it leaves at least 90 s of the 10-minute cap for the final diagnosis and process start.
- **Diagnosis budget:** ≤5 jobs × 2 log fetches (8 MB and 20 s cap each) plus the main comparison, all under its own 60 s deadline. If it overruns, the summary says `diagnosis.partial:true`.
- **Soft stop:** at `deadline − 90 s` the generator stops polling, diagnoses, and returns `outcome:"timeout"` (exit 8). 01's hard abort never fires in normal operation.
- **Lines** are `{type, seq, at, …}`, flushed one at a time, ≤4,096 bytes each. The last line is always `summary` or `error`.
- **Signals** produce `outcome:"interrupted"` through 01's graceful path, exit 130/143.
- **`--if-eta-under <dur>`:** if the p90 ETA exceeds `dur`, ghx returns at once with `outcome:"timeout", reason:"eta-exceeds"` (exit 8). A blocking caller sees nothing until exit, so this is how it decides to background instead. `pr status.ci.eta` shows the same ETA.

### 11.2 Until-modes

| Mode | Terminal when | Outcome |
|---|---|---|
| `settled` (default) | All considered checks are complete, required and config checks have reported, and baseline checks have reported or aged out | green, red-shared or red |
| `first-failure` | The first failure (diagnosed immediately), or settled green | red-shared or red early, otherwise green |
| `mergeable` | Settled, mergeable resolved (§4.3), and the merge CI gate evaluated (§8.2 rows 6–12) | green if no failures and MERGEABLE; red-shared if only shared failures and MERGEABLE; otherwise red, with `merge.blockers` |

- red-shared exits 11 in every mode.
- There is no `green` mode: it would be identical to `first-failure`.
- Considered checks are the reported checks for the bound SHA, minus `ci.ignore` (§6), filtered by `--check`.

### 11.3 Expected checks and phases

| Source | How | If it never reports |
|---|---|---|
| required | `GET repos/o/r/rules/branches/<base>` plus the protection summary from `GET repos/o/r/branches/<base>`, plus `isRequired`. **Spike:** both readable without admin (`…/protection` needs admin and is not used) | Never green. Stays in `expectedMissing` until the budget runs out |
| config | `ci.expected: [{name, workflow?, paths?}]`, applied when the paths match | Same as required |
| baseline | Check names, in priority order: (1) the PR's previous head SHA (for branch targets, the previous commit); (2) the last PR merged into the base; (3) the base head (`confidence:"low"`). Cached | Ages to `absent` after `--expect-grace` (90 s) once everything else settles, emitting `expected-absent`. Covers path-filtered and main-only jobs |

Phases:
- **`registering`:** nothing reported yet. After `--grace` (default 120 s; §3.1 and §5.2 saw 10–60 s), the outcome is `no-checks`, exit 13.
- **`partial`:** some checks reported, but required or config checks are missing or baseline checks are still within their grace. Never green. This catches `workflow_run` chains and late registration.
- **`running`:** all expected checks registered, some pending.
- **`settled`:** done.

### 11.4 Fail fast with a diagnosis

- **Immediate.** When a considered check fails, ghx runs the `ci why` engine (§12) on that job right away (disable with `--no-diagnose`). The failed job is complete even mid-run, so the jobs-logs API works **[G-LOGS]**. That is exactly where `gh run view --log` failed 16 times (§3.1).
- **`diagnosis` events:** at most 5. Each carries an excerpt of ≤10 lines or 1,500 chars, ≤10 tests and ≤5 errors, so it fits in 4 KB. The full log is at `logPath`.
- **Main comparison:** once per failing workflow (§1.5).
- **The summary is self-contained.** Each failing job has its step, ≤5 tests, the first error, the log path, the main verdict and the flake score. `diagnosisPath` holds the full JSON. No follow-up `ci why` is needed (§5.1: median of 6 calls).

### 11.5 Head-SHA binding

| Target | Bound SHA | On a head change (default) |
|---|---|---|
| PR | `headRefOid` at start | `restart`: emit `head-changed`, rebind, and reset grace and per-check state. The budget is not reset |
| `branch:<name>` | Head at start | `stay`: keep the bound SHA and emit `branch-advanced`. Main moves with every merge; you want your own commit |
| `branch:<name>@<sha>` | `<sha>` | `stay` |

- `--on-head-change stop` ends with `superseded` (12).
- A PR that closes or merges mid-wait ends with `closed` (12).
- Every event carries `headSha` (§5.4: 175 + 150 manual SHA checks).

### 11.6 ETA and adaptive backoff

**ETA.**
- Per pending check: the median and p90 of that job's duration over the last ≤10 successful runs of the same workflow on the base branch.
- Base-branch push runs count only if their job names match the PR's jobs; otherwise ghx uses recent `pull_request` runs into the base.
- Queued checks add the median queue time.
- Sources: `GET actions/workflows/{id}/runs?branch=<base>&status=success&per_page=10`, plus `GET actions/runs/{id}/jobs` for ≤3 samples.
- Cached on disk for 24 h per repo and workflow (01's cache dir).
- `eta` = max over pending checks of (median − elapsed), clipped at 0, with p90 alongside. It appears in `start` and `progress` events and in `pr status`.

**Polling.** `gh api` and `gh graphql` only, never porcelain, so 01's rate budget can see every call.
- **Primary:** each tick sends `GET pulls/N`, `GET commits/{sha}/check-runs?filter=latest&per_page=100` and `GET commits/{sha}/status`, all with `If-None-Match`. A 304 doesn't count against the rate limit. **Spike (01 commit 7):** how `gh api --include` reports a 304.
- **Fallback:** one GraphQL query per tick with `rateLimit`.
- **New check suites** are mapped to their runs once via GraphQL.

**Interval.**

| Situation | Interval |
|---|---|
| registering | 10 s |
| running | eta/6, clamped to 15–60 s |
| within 60 s of an expected completion | 10 s |
| after the ETA is overrun | 30 s |
| `--max` mode | at least 30 s |

- When <10% of the rate budget remains, the interval is multiplied by 4 and a `rate-limit` event is emitted. When the budget is exhausted, ghx pauses until `resetAt`.
- All intervals get ±10% jitter.

### 11.7 Multiple targets

- Up to 10 targets share one loop. Every event carries `target`, and each target has its own state machine.
- By default the command returns when all targets are done. `--any` returns at the first terminal target (merge trains, §5.3).
- The summary has per-target `results[]` and an aggregate outcome; the exit code follows the precedence in §6.1.
- `pr merge` suggests `ghx ci wait branch:main@<mergeCommit>`.

### 11.8 Flake signals

`ci wait` reports flake signals; reruns live in `ci rerun --flaky`.

| Signal | Source |
|---|---|
| `same-sha-passed` | The job passed earlier on the same SHA: `GET actions/runs/{id}/attempts/{n}/jobs`, or other runs via `GET actions/runs?head_sha=`. The strongest signal |
| `main-intermittent` | Test names parsed from ≤5 recent failed main runs interleave with passing runs. Parsed lists are cached by job id (logs are immutable) |
| `known-flaky` | Matches `ci.knownFlaky: [{job, test?}]` |
| `infra-error` | Log patterns: runner shutdown, `ECONNRESET`, `429 Too Many Requests` (Docker Hub, §1), `No space left on device`, plus `ci.infraPatterns` |

- **Score:** high = same-sha-passed or infra-error; medium = main-intermittent or known-flaky; otherwise low or none. A score of medium or higher makes the job a candidate.
- **Summary:** lists `rerunCandidates` and suggests `next: ["ghx ci rerun <ref> --flaky"]`.
- **`ci wait` never reruns anything itself** (Pushback).

### 11.9 Schemas

01 adds `type`, `seq` and `at` to every line, and emits its own `warning` and `heartbeat` lines.

```ts
const T = { target: z.string() };
const WaitEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), ...T, headSha: Sha, until: z.string(), budgetSec: z.number(), phase: z.string(),
    counts: CiSummary.shape.counts, expected: z.array(ExpectedCheck), eta: CiSummary.shape.eta, advice: z.enum(["block","background"]) }),
  z.object({ type: z.literal("phase"), ...T, headSha: Sha, from: z.string(), to: z.string() }),
  z.object({ type: z.literal("check"), ...T, headSha: Sha, name: z.string(), workflow: z.string().nullable(),
    from: z.union([Bucket, z.literal("absent")]), to: Bucket, conclusion: z.string().nullable(), required: z.boolean(),
    runId: z.number().nullable(), jobId: z.number().nullable(), url: z.string() }),
  z.object({ type: z.literal("expected-absent"), ...T, name: z.string(), source: z.literal("baseline") }),
  z.object({ type: z.literal("diagnosis"), ...T, headSha: Sha, job: FailingJob }),
  z.object({ type: z.literal("progress"), ...T, headSha: Sha, counts: CiSummary.shape.counts, eta: CiSummary.shape.eta }),
  z.object({ type: z.literal("head-changed"), ...T, from: Sha, to: Sha, action: z.enum(["restart","stop"]) }),
  z.object({ type: z.literal("branch-advanced"), ...T, boundSha: Sha, branchHead: Sha }),
  z.object({ type: z.literal("rate-limit"), ...T, remaining: z.number(), resetAt: Iso, intervalSec: z.number() }),
]);
const Outcome = z.enum(["green","red","red-shared","timeout","superseded","closed","no-checks","interrupted"]);
const CompactDiagnosis = z.object({ job: z.string(), workflow: z.string(), jobId: z.number(), step: z.string().nullable(),
  tests: z.array(z.string()).max(5), firstError: z.string().nullable(), logPath: z.string().nullable(),
  sameOnMain: SameOnMain.shape.verdict, flake: Flake.shape.score });
const TargetSummary = z.object({ target: z.string(), outcome: Outcome, reason: z.string().nullable(), headSha: Sha,
  restarts: z.number(), elapsedSec: z.number(),
  ci: z.object({ state: CiSummary.shape.state, phase: CiSummary.shape.phase, counts: CiSummary.shape.counts,
    failing: z.array(z.object({ name: z.string(), workflow: z.string().nullable(), jobId: z.number().nullable(), runId: z.number().nullable() })),
    expectedMissing: z.array(z.string()) }),
  diagnosis: z.object({ jobs: z.array(CompactDiagnosis).max(5), partial: z.boolean() }).nullable(),
  rerunCandidates: z.array(z.number()),
  merge: z.object({ mergeable: z.string(), ready: z.boolean(), blockers: z.array(z.string()), waivers: z.array(z.string()) }).nullable(),
  next: z.array(z.string()) });
const WaitSummary = z.object({ outcome: Outcome, exitCode: z.number(), results: z.array(TargetSummary), diagnosisPath: z.string().nullable() });
```

- `progress` is emitted at most every 60 s when nothing else happens.
- A single-target summary fits in 4 KB. A multi-target one may not (§15, ask 2).

### 11.10 Errors and gh calls

- **Before the first line:** a plain error document: `USAGE_*` or `VALIDATION` (2), `PR_NOT_FOUND` (5), `ENV_*` (4), `GH_*` (7).
- **Mid-wait fatal:** a terminal `error` line, exit 7.

gh calls:
1. Snapshot with the oid check **[G-SHA]**.
2. Expected set, cached.
3. ETA baselines, cached.
4. Each tick: conditional REST, or the GraphQL fallback.
5. On a failure: jobs and logs **[G-LOGS]**, the main comparison, flake checks.
6. `mergeable` mode: the mergeable retry **[G-UNKNOWN]** and the gate.

---

## 12. `ci why`

```
ghx ci why <pr> [--job <glob>]… [--no-compare-main] [--max-jobs 5] [--excerpt-lines 20]
ghx ci why --run <run-id|run-url> [-R owner/repo]
```

Answers "why is CI red?" in one call (§5.1, §9.1).

```ts
const FailingJob = z.object({ workflow: z.string(), job: z.string(), jobId: z.number(), runId: z.number(), attempt: z.number(),
  url: z.string(), conclusion: z.string(), required: z.boolean(),
  step: z.object({ number: z.number(), name: z.string() }).nullable(),   // jobs API, not "UNKNOWN STEP" (§6)
  tests: z.array(z.string()).max(30), errors: z.array(z.string()).max(20), exitLine: z.string().nullable(),
  excerpt: z.string(),                // ≤ --excerpt-lines (default 20, cap 60), ≤ 2,000 chars
  logPath: z.string().nullable(), logBytes: z.number().nullable(), sameOnMain: SameOnMain, flake: Flake });
const CiWhyOutput = z.object({ ref: PrRef.nullable(), headSha: Sha, ci: CiSummary, failing: z.array(FailingJob),
  nonActionsFailing: z.array(Check),
  suspicious: z.array(z.object({ workflow: z.string(), job: z.string(), jobId: z.number(), step: z.string(),
    reason: z.enum(["key-step-skipped","no-tests-ran"]) })),          // §6 misleading green
  omitted: z.number(), next: z.array(z.string()), warnings: z.array(Warning) });
```

With the defaults, 5 jobs fit under 16 KB; the spill is the safety net.

**Log processing:**
1. Fetch the raw job log over REST.
2. Strip ANSI codes and timestamps (agents stripped ANSI by hand 101 times).
3. Attribute lines to steps using `##[group]` markers, cross-checked with the jobs API.
4. Extract matches for ` FAIL `, `×`, `✘`, `AssertionError`, `Tests .* failed`, `##[error]`, `ERR_PNPM` (§5.1) and `ci.logPatterns`.
5. Write the log to `<root>/<host>/<owner>/<repo>/logs/job-<jobId>.log` (01's layout).

| Exit | Codes |
|---|---|
| 0 | No failures (`failing: []`) |
| 5 | `PR_NOT_FOUND`, `RUN_NOT_FOUND` |
| 7 | `GH_*` |

An expired log sets `logPath:null` and warns `LOGS_UNAVAILABLE`.

gh calls:
1. Rollup with the oid check **[G-SHA]** (or `actions/runs/{id}` with `--run`).
2. For each failing job: `GET actions/jobs/{id}` and `…/logs` **[G-LOGS]**. Never `gh run view --log`.
3. `GET actions/runs/{id}/jobs` for `ci.keySteps`.
4. Main comparison (§1.5).
5. Flake checks (§11.8).

---

## 13. `ci rerun` and `ci retrigger`

### 13.1 `ci rerun`

```
ghx ci rerun <pr> [--job <glob>]… [--flaky] [--expect-head <sha>] [--override RERUN_LIMIT --reason "…"] [--dry-run]
```

Reruns failed jobs of completed runs for the current head only. §5.4 found 44 reruns, mostly after hand-parsing ids.

- **Scope.** Only failing Actions runs with `head_sha == H` are considered.
- **Skips.** Runs not yet completed are skipped as `RUN_IN_PROGRESS` (§3.1). Runs at `run_attempt ≥ ci.maxRerunAttempts` (default 3) are skipped as `RERUN_LIMIT`.
- **Targeting.** `--job` reruns matching jobs via `POST actions/jobs/{id}/rerun`. Otherwise ghx calls `POST actions/runs/{id}/rerun-failed-jobs`.
- **`--flaky`** limits the rerun to jobs with a flake score of medium or higher (§11.8), reports their `flake` evidence, and fails with `NO_FLAKY_CANDIDATES` if there are none.
- **Nothing to rerun:** the error is `NO_FAILED_RUNS`, `RUN_IN_PROGRESS` or `RERUN_LIMIT`, in that order of precedence.
- **Hint:** a rerun reuses the original merge ref. After a base change, use `ci retrigger`.

Output: `{ref, headSha, rerun: [{runId, workflow, jobs, previousAttempt, url, flake}], skipped: [{runId, workflow, reason}], next: ["ghx ci wait <ref>"], warnings}`.

gh calls:
1. Rollup **[G-SHA]**.
2. `GET actions/runs/{id}`.
3. Flake checks (`--flaky` only).
4. The rerun POSTs.

### 13.2 `ci retrigger`

```
ghx ci retrigger <pr> [--expect-head <sha>] [--wait-for-runs 60s] [--override AUTHOR_NOT_VIEWER --reason "…"] [--dry-run]
```

Fires fresh `pull_request` workflows, replacing the agents' `close && reopen && sleep` (§5.4).

- **Mechanism:** `PATCH pulls/N {state:"closed"}`, then `{state:"open"}`. The `reopened` event (a default trigger) carries the current merge ref, which a rerun can't.
- **Preflight:**
  - PR is open (`PR_NOT_OPEN`).
  - Head branch exists (`HEAD_BRANCH_MISSING`); a deleted head can't be reopened.
  - Base branch exists (`BRANCH_MISSING`).
  - Author is the viewer (`AUTHOR_NOT_VIEWER`, overridable).
  - `--expect-head` matches.
- **Reopen failure:** retry 3 times, then `REOPEN_FAILED` (7) with a hint to reopen in the UI. A closed PR is never left behind silently.
- **Verification:** poll for new suites on `H` within `--wait-for-runs`. If none appear, warn `NO_NEW_RUNS`.

Output: `{ref, headSha, closedAt, reopenedAt, newRuns, next: ["ghx ci wait <ref>"], warnings}`.

---

## 14. Worked example

The repo is `powerhouse-inc/powerhouse`. Its `.github/ghx.json` has components `reactor`, `reactor-api`, `shared`, `connect`, `switchboard`, `codegen`, `vetra`, `docs` and `ci`, sets `ci.ignore` to `["notify-discord", "CI duration watch"]`, and uses `merge.method: merge`.

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

This passes validation:
- The title is 68 chars, conventional, and scoped to `reactor`, which is both in config and in `components`.
- The description is 2 lines, about 265 chars, with no structure.
- All 3 tests pass and are re-runnable.
- Risk is medium with a note.
- Draft is derived as false.

### 14.2 Rendered body (#3301)

```markdown
The primary write path in reactor-client signed actions without binding documentId, so a signature made for one document also verified on another.
signAction now always binds the target documentId, and verify rejects unbound candidates instead of accepting them.

Risk: medium · Components: reactor, shared · Revert: revert-safe · Tests: 3/3 pass (unit, integration, typecheck) · Closes #2894

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"t":"pr","id":"p_k3m9qa","gen":"ghx/0.1.0","rev":1,"title":"fix(reactor): bind documentId when signing actions on the write path","description":"The primary write path in reactor-client signed actions without binding documentId, so a signature made for one document also verified on another.\nsignAction now always binds the target documentId, and verify rejects unbound candidates instead of accepting them.","testing":[{"kind":"unit","command":"pnpm --filter @powerhousedao/reactor test -- signature","result":"pass","notes":"4 new cases: unbound and cross-document signatures"},{"kind":"integration","command":"pnpm --filter @powerhousedao/reactor-api test","result":"pass"},{"kind":"typecheck","command":"pnpm tsc -b","result":"pass"}],"risk":"medium","riskNote":"Clients that sign without a documentId now get a verification error instead of silent acceptance.","components":["reactor","shared"],"revertPolicy":"revert-safe","refs":{"closes":["#2894"]}} -->
```

### 14.3 Review, fix and other feedback

**1. A review on head `4b1e7d2`** via `ghx pr review powerhouse-inc/powerhouse#3301 --input review.json`:

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

It's a self-review, so it's posted as `COMMENT` with `verdictDowngraded: true`. The high finding's inline comment:

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

**2. The fix.** After pushing `9f2c4e1`, the agent runs `ghx pr resolve powerhouse-inc/powerhouse#3301 f_h4x8pz --status addressed --commit 9f2c4e1`. This posts a thread reply and resolves the thread:

```markdown
Addressed in 9f2c4e1.

<!-- ghx:v1 {"t":"comment","id":"c_w5j1ve","gen":"ghx/0.1.0","kind":"resolve","targets":[{"id":"f_h4x8pz","status":"addressed","commit":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d"}]} -->
```

**3. Other feedback:** a comment from `maria-dev` (MEMBER) with no block, and a `github-actions[bot]` comment that starts with `<!-- ci-duration-watch -->`.

### 14.4 `ci wait` stream for head `9f2c4e1`

The command was `ghx ci wait powerhouse-inc/powerhouse#3301 --until first-failure --max 30m`, run in the background.

```
{"type":"start","seq":0,"at":"2026-10-21T16:23:05Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","until":"first-failure","budgetSec":1800,"phase":"partial","counts":{"pass":0,"fail":0,"pending":9,"skipped":0,"cancelled":0,"neutral":0,"ignored":1},"expected":[{"name":"Test Reactor (shard 1/3)","workflow":"CI","source":"baseline","state":"reported"},{"name":"e2e-tests","workflow":"E2E","source":"baseline","state":"missing"}],"eta":{"seconds":1080,"p90Seconds":1320,"basis":"CI@main: 10 runs, E2E@main: 8 runs"},"advice":"background"}
{"type":"phase","seq":1,"at":"2026-10-21T16:23:41Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","from":"partial","to":"running"}
{"type":"check","seq":2,"at":"2026-10-21T16:27:12Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","name":"Typecheck","workflow":"CI","from":"pending","to":"pass","conclusion":"success","required":true,"runId":37948190914,"jobId":111978835001,"url":"https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835001"}
{"type":"check","seq":3,"at":"2026-10-21T16:41:05Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","name":"Test Reactor (shard 1/3)","workflow":"CI","from":"pending","to":"fail","conclusion":"failure","required":false,"runId":37948190914,"jobId":111978835495,"url":"https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495"}
{"type":"diagnosis","seq":4,"at":"2026-10-21T16:41:19Z","target":"powerhouse-inc/powerhouse#3301","headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","job":{"workflow":"CI","job":"Test Reactor (shard 1/3)","jobId":111978835495,"runId":37948190914,"attempt":1,"url":"https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495","conclusion":"failure","required":false,"step":{"number":6,"name":"Run tests"},"tests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"errors":["AssertionError: expected 3 to equal 4"],"exitLine":"Process completed with exit code 1.","excerpt":"× should converge after reshuffle rebroadcast between two connect reactors 20056ms\n  AssertionError: expected 3 to equal 4","logPath":"/…/ghx/github.com/powerhouse-inc/powerhouse/logs/job-111978835495.log","logBytes":2318840,"sameOnMain":{"verdict":"same-tests","mainBranch":"main","mainRunId":37950011223,"mainSha":"c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3","mainRunAt":"2026-10-21T15:58:19Z","prTests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"mainTests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"newTests":[]},"flake":{"candidate":true,"score":"medium","signals":[{"kind":"main-intermittent","detail":"failed 3 of last 10 main runs, interleaved with passes"}]}}}
{"type":"summary","seq":5,"at":"2026-10-21T16:41:20Z","outcome":"red-shared","exitCode":11,"diagnosisPath":"/…/ghx/github.com/powerhouse-inc/powerhouse/ci-wait/3301-9f2c4e1.json","results":[{"target":"powerhouse-inc/powerhouse#3301","outcome":"red-shared","reason":null,"headSha":"9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d","restarts":0,"elapsedSec":1095,"ci":{"state":"red","phase":"running","counts":{"pass":14,"fail":1,"pending":7,"skipped":1,"cancelled":0,"neutral":0,"ignored":1},"failing":[{"name":"Test Reactor (shard 1/3)","workflow":"CI","jobId":111978835495,"runId":37948190914}],"expectedMissing":[]},"diagnosis":{"jobs":[{"job":"Test Reactor (shard 1/3)","workflow":"CI","jobId":111978835495,"step":"Run tests","tests":["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],"firstError":"AssertionError: expected 3 to equal 4","logPath":"/…/ghx/github.com/powerhouse-inc/powerhouse/logs/job-111978835495.log","sameOnMain":"same-tests","flake":"medium"}],"partial":false},"rerunCandidates":[111978835495],"merge":null,"next":["ghx pr merge powerhouse-inc/powerhouse#3301 --expect-head 9f2c4e1 --dry-run","ghx ci rerun powerhouse-inc/powerhouse#3301 --flaky"]}]}
```

How to read this stream:
- The start event advises `background` because p90 (22m) exceeds the 8m default. A blocking caller using `--if-eta-under 7m` would have got exit 8 at once.
- The run took 1,095 s of its 1,800 s budget.
- `running` means `e2e-tests` registered, so nothing is left in `expectedMissing`.

### 14.5 `ghx pr status powerhouse-inc/powerhouse#3301` (after settle)

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
    "id": "p_k3m9qa", "rev": 1, "gen": "ghx/0.1.0", "risk": "medium",
    "riskNote": "Clients that sign without a documentId now get a verification error instead of silent acceptance.",
    "components": ["reactor", "shared"], "revertPolicy": "revert-safe", "revertNote": null, "revertWith": [],
    "testing": [
      {"kind": "unit", "command": "pnpm --filter @powerhousedao/reactor test -- signature", "result": "pass", "notes": "4 new cases: unbound and cross-document signatures"},
      {"kind": "integration", "command": "pnpm --filter @powerhousedao/reactor-api test", "result": "pass"},
      {"kind": "typecheck", "command": "pnpm tsc -b", "result": "pass"}
    ],
    "refs": {"closes": ["#2894"]}
  },
  "metaError": null,
  "merge": {
    "mergeable": "MERGEABLE", "settled": true, "mergeStateStatus": "UNSTABLE", "reviewDecision": null, "method": "merge", "ready": true,
    "blockers": [],
    "waivers": [{"code": "CI_RED", "message": "Test Reactor (shard 1/3) fails with the same test on main run 37950011223 (c0ffee1).", "overridable": true}],
    "warnings": [{"code": "FINDINGS_OPEN", "message": "1 open low finding (f_n2c6rv); below merge.blockOnSeverity (high).", "overridable": true}],
    "mergedAt": null, "mergeCommit": null
  },
  "ci": {
    "headSha": "9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d", "forHeadSha": true, "state": "red", "phase": "settled",
    "counts": {"pass": 21, "fail": 1, "pending": 0, "skipped": 1, "cancelled": 0, "neutral": 0, "ignored": 2},
    "failing": [{
      "name": "Test Reactor (shard 1/3)", "workflow": "CI", "kind": "actions", "bucket": "fail", "status": "completed",
      "conclusion": "failure", "required": false, "runId": 37948190914, "jobId": 111978835495, "attempt": 1,
      "url": "https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495",
      "startedAt": "2026-10-21T16:23:30Z", "completedAt": "2026-10-21T16:41:02Z",
      "sameOnMain": {"verdict": "same-tests", "mainBranch": "main", "mainRunId": 37950011223,
        "mainSha": "c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3", "mainRunAt": "2026-10-21T15:58:19Z",
        "prTests": ["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"],
        "mainTests": ["reactor-api > should converge after reshuffle rebroadcast between two connect reactors"], "newTests": []},
      "flake": null
    }],
    "pending": [], "ignored": ["notify-discord", "CI duration watch"], "expectedMissing": [], "eta": null,
    "next": ["ghx ci why powerhouse-inc/powerhouse#3301"]
  },
  "feedback": {
    "reviews": [{
      "id": "r_7tq2wd", "structured": true,
      "author": {"login": "thegoldenmule", "isViewer": true, "isBot": false, "association": "MEMBER"},
      "verdict": "request-changes", "githubState": "COMMENTED", "verdictDowngraded": true,
      "submittedAt": "2026-10-21T15:40:03Z", "commit": "4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47", "outdated": true,
      "summary": "The signing fix covers createDocument and addActions, but deleteDocument still signs without a documentId.",
      "truncated": false, "findingIds": ["f_h4x8pz", "f_n2c6rv"],
      "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#pullrequestreview-2398765432"
    }],
    "findings": [
      {"id": "f_h4x8pz", "reviewId": "r_7tq2wd", "severity": "high",
       "path": "packages/reactor/src/client/reactor-client.ts", "line": 1071, "endLine": null,
       "alsoAt": [{"path": "packages/reactor/src/client/reactor-client.ts", "line": 1111}],
       "title": "deleteDocument still signs without documentId",
       "body": "deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document.",
       "truncated": false, "inline": true, "commit": "4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47", "outdated": true,
       "status": "addressed",
       "statusEvent": {"id": "c_w5j1ve", "by": "thegoldenmule", "at": "2026-10-21T16:22:45Z",
         "commit": "9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d", "note": null, "verified": true,
         "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834570012"},
       "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834567890"},
      {"id": "f_n2c6rv", "reviewId": "r_7tq2wd", "severity": "low",
       "path": "packages/shared/document-model/crypto.ts", "line": 179, "endLine": null, "alsoAt": [],
       "title": "Rejection error does not name the documentId",
       "body": "The thrown error says \"signature not bound\" without the expected and actual documentId, which makes client logs hard to trace.",
       "truncated": false, "inline": true, "commit": "4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47", "outdated": false,
       "status": "open", "statusEvent": null,
       "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834567955"}
    ],
    "comments": [
      {"id": "c_w5j1ve", "source": "inline",
       "author": {"login": "thegoldenmule", "isViewer": true, "isBot": false, "association": "MEMBER"},
       "at": "2026-10-21T16:22:45Z", "body": "Addressed in 9f2c4e1.", "truncated": false, "structured": true, "kind": "resolve",
       "path": "packages/reactor/src/client/reactor-client.ts", "line": 1071, "threadResolved": true, "inReplyTo": "f_h4x8pz",
       "edited": false, "blockError": null, "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#discussion_r1834570012"},
      {"id": "ic:2412345678", "source": "issue",
       "author": {"login": "maria-dev", "isViewer": false, "isBot": false, "association": "MEMBER"},
       "at": "2026-10-21T16:05:12Z",
       "body": "Does connect need a Switchboard release before this lands, or is the verify change backward compatible?",
       "truncated": false, "structured": false, "kind": null, "path": null, "line": null, "threadResolved": null, "inReplyTo": null,
       "edited": false, "blockError": null, "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-2412345678"}
    ],
    "bots": [{"id": "ic:2412399001", "source": "issue", "author": "github-actions[bot]", "at": "2026-10-21T16:30:40Z",
      "marker": "ci-duration-watch", "summary": "⚠️ CI duration regression: Test Reactor (shard 2/3) 14m02s vs baseline median 9m40s",
      "path": null, "line": null, "url": "https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-2412399001"}],
    "counts": {"reviews": 1, "findingsTotal": 2, "findingsOpen": 1, "comments": 2, "bots": 1, "unresolvedHumanThreads": 0, "omitted": 0}
  },
  "openFindings": ["f_n2c6rv"],
  "preconditions": [],
  "stack": {"parent": null, "declaredParent": null, "children": [], "baseChanges": []},
  "warnings": [],
  "fetchedAt": "2026-10-22T09:15:00Z"
}
```

`ready` is true because the red check is waived as shared with main (§4.3) and the only open finding is low. Next: `ghx pr merge powerhouse-inc/powerhouse#3301 --expect-head 9f2c4e1`.

---

## 15. Config keys and asks of 01

**Config keys** (`.github/ghx.json`):
- `components[{name, paths?, minRisk?}]`
- `title.types`, `title.scopeRequired`
- `render.mode`, `render.footer`, `render.descriptionMaxChars`
- `create.requirePassingTest`
- `merge.method`, `merge.allowedMethods`, `merge.sharedRed`, `merge.blockOnSeverity`, `merge.requireOwnPr`, `merge.deleteBranch`
- `ci.none`, `ci.ignore`, `ci.expected`, `ci.keySteps`, `ci.logPatterns`, `ci.infraPatterns`, `ci.knownFlaky`, `ci.maxRerunAttempts`
- `trust.associations`, `trust.bots`
- `bots.logins`, `bots.markers`

**Asks of 01:**
1. **Remote config source.** When the target repo isn't the cwd repo (§4.1 sektar), fetch `GET repos/o/r/contents/.github/ghx.json?ref=<base|default>`, validate it the same way, and set `source:"remote"`.
2. **Summary line bound.** Bound the stream's terminal `summary` line by `maxBytes` (16 KB) rather than 4 KB. Single-target summaries fit in 4 KB either way; otherwise the payload spills and `diagnosisPath` carries the detail.
3. **`onUnknown` hints.** Add the three §10 hint variants. The unwrapped-write list is a static table.
4. **Read guard.** Allow `api` GET with an `If-None-Match` header.
5. **Spikes:**
   - how `gh api --include` reports a 304;
   - whether the rulesets and branch endpoints are readable without admin;
   - whether `gh api` follows the job-logs redirect.

---

## 16. Pushback

1. **`pr edit` is in v1, although brief 8 omits it.**
   - Bodies were edited 35 times across 24 PRs, up to 4 times each (§4.2).
   - Raw `gh pr edit` is now denied by `permissions.deny`, so without `pr edit` bodies couldn't be fixed at all. Any outside edit would also destroy the block.
   - It also covers `pr ready` (12 calls) and base retargets, and it reuses the create validator and renderer.
   - `pr resolve` falls under §9.6.
2. **The flake rerun moved from `ci wait --rerun-flaky` to `ci rerun --flaky`.** The brief now makes reads mechanically read-only. `ci wait` still computes flake signals, lists `rerunCandidates` and suggests the exact command. The cost is one plain extra call; the benefit is no read/write blur (§9.7).
3. **GitHub verdicts won't reflect ghx verdicts on the user's own PRs.** The user's token can't approve or request changes on their own PRs, so ghx posts `COMMENT` with the verdict in the block (`verdictDowngraded`). `reviewDecision` stays empty, as it is today (§7). Human vs ghx is decided by block presence, and authority by facts (§9.4).
4. **The input object gains conditional fields:** `riskNote`, `revertNote` and `revertWith`. The description also gets a 500-char cap and a ban on markdown structure. Both encode the user's two corrections (§4.1).
5. **Exit codes go beyond the four outcomes the coordinator named.**
   - 11 (red, shared with main) exists because the user's rule makes it mergeable (§4.3).
   - 13 (no checks) exists because treating "nothing registered" as green is the misread behind 11 cases in §3.1.
   - A `ci wait` timeout reuses 8.
   - The numbering starts from 01's provisional table, which 02 now finalizes.
6. **No passthrough.** Raw reads remain available under the confirmed steering, so ghx refuses unknown commands and points to the right tool. Unwrapped reads keep gh's output format.

### Critical files
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/plans/00-brief.md
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/plans/01-scaffolding.md
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/research/gh-usage-findings.md
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/docs/plans/02-api.md (target)
