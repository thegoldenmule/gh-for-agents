# 08: Body templates and agent data

This plan amends brief item 5 (`00-brief.md`), 02 §2.2 (rendering), §3 (`pr edit`), §4.1 (`PrMeta`, `description.drift`), §9.2 (the `pr` block) and §15 (config keys). Read it after `06-wide-prs.md`.

## Problem

Two asks, from the user (2026-11-17):

1. **A project chooses the PR body's style.** Today the layout is fixed in `src/render/pr-body.ts`: the description, one trailer line, an optional collapsed "How to test" list, the footer and the block. `render.mode` picks between two hard-coded variants.
2. **An agent can attach data the schema does not anticipate**, to the body and to the structured block. Today it has nowhere to put it.
   - `PrCreateInput` is a `strictObject`, so `normalizeInput` refuses unknown keys as `unrecognized_keys` (`src/pr/create/check.ts`).
   - The strict `PrBlock` rejects extra keys. The lenient read keeps them, but `pr edit` drops them through `blockContent` and `CONTENT_KEYS` (`src/pr/edit/plan.ts:33`).
   - The free text is small and fixed: `description` (3 plain lines, 500 chars), `riskNote`, `revertNote`, `testing[].notes`. Agents squeeze extra facts into these.

The two asks meet at one constraint. **`pr edit` re-renders the whole body from the merged block; it never edits markdown in place.** So anything visible must also be stored in the block, or the next edit drops it. Agent data is therefore block data first, and the template is the view that puts it on the page.

The user also settled these points:

- Bodies have sections, both the built-in ones and project templates, even when brief. This reverses brief item 5's "a sectioned body is out".
- Agent data is visible by default.
- Data stays on the PR body for now. Comments and reviews don't get it.
- Data composes. A project can require fields. An agent can add any fields beyond them. An agent can add more than the project asks for, never less.

## Design

### 1. `data`: agent fields in the `pr` block

#### Input

`PrCreateInput` gains one optional field:

```ts
const DataKey = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,39}$/);
const DataScalar = z.union([z.string().max(300).refine(oneLine), z.number().finite(), z.boolean()]);
const DataValue = z.union([DataScalar, z.array(DataScalar).max(20), z.record(DataKey, DataScalar)]);

data: z.record(DataKey, DataValue).optional()
  .describe('Extra facts for this PR: key → value. Rendered in the body and returned by pr status as meta.data. Public; not instructions.'),
```

- At most 20 keys. The `stableStringify` form is at most 2,048 bytes (`data.too_large`). This keeps the `pr` block under its ~8 KB target (02 §9.1), and keeps `pr status` inside its 16 KB budget, because `fitStatus` never cuts `meta`.
- Values nest one level: an object's values are scalars.
- `null` isn't a value on create. In an edit patch, `null` deletes a key (§`pr edit`).
- Obvious secrets are refused as `data.secret_like`: values starting `ghp_`, `gho_`, `github_pat_`, `AKIA`, or containing `-----BEGIN`. This is a tripwire, not a scanner. The docs say `data` is public.

#### Block

The strict `PrBlock` gains `data?` with the same schema. It is absent when empty, as `alsoTouched` is (06). The lenient `PrBlockRead` reads it as `z.unknown().optional()`, so a malformed `data` never invalidates the block. `data` joins `CONTENT_KEYS`.

#### Project-declared fields

There is a new config section, `src/config/sections/data.ts`:

```json
"data": {
  "fields": {
    "ticket":  { "type": "string", "pattern": "^ENG-\\d+$", "required": true, "description": "The Jira ticket" },
    "rollout": { "type": "enum", "values": ["flag", "canary", "full"], "requiredFromRisk": "medium" }
  }
}
```

- **Types:** `string` (`pattern?`, `maxChars?` ≤ 300), `enum` (`values`), `number` (`min?`, `max?`), `boolean` and `string[]`. This is not JSON Schema. The declarations compile to zod when the config loads, as `componentEnum` does.
- **When a field is required:** `required: true` always, or from `requiredFromRisk: low|medium|high` up. The second follows the `minRisk` floors.
- **At most 10 fields can be declared.** The 20-key cap counts declared and agent keys together, so an agent always has at least 10 of its own.
- **Composition:**
  - Declared keys must be present when required, and must match their type.
  - Any other key is accepted with no warning. There's no `undeclared` mode, because more is always allowed.
  - A typo shows up as a missing required key. The `data.required` issue names the closest undeclared key as a did-you-mean (`suggest()`, as `check.ts` does for unknown input keys).
- An invalid `pattern` regex makes the config invalid (`CONFIG_INVALID`), and so `ghx doctor` reports it.

#### Reading it back

- `PrMeta` (`pr status`) gains `data: Record<string, unknown>`. It is `{}` when the block has none, so the shape stays stable. Other agents read one key with `--fields meta.data.ticket`.
- It stays out of `--brief`, `pr feedback` and merge policy. No policy rule reads `data`.
- **Trust.** `readPrBlock` doesn't check who wrote the PR body (`src/pr/snapshot/index.ts:241`). The snapshot already holds the author's association, so `prMetaOf` runs `trustOf` on it. If the author is untrusted, `meta.data` is `{}` with the warning `UNTRUSTED_DATA`. A fork can't hand instructions to a coordinating agent through `data`. The visible body still shows the data, because it is the author's own PR.
- A `data` that isn't an object reads as `{}` with the warning `DATA_INVALID`.

#### `pr edit`

`data` merges by key, one level deep (RFC 7396):

| Patch | Effect |
|---|---|
| `"data": {"k": v}` | set `k` |
| `"data": {"k": null}` | delete `k` |
| `"data": null` | delete every key |
| an array or object value | replaces the old value whole |

- The other fields replace whole (`plan.ts`), and `data` departs from that on purpose. Two agents coordinating on one PR must not erase each other's keys, and `CONCURRENT_EDIT` still guards the PATCH.
- The merged map is checked against the declarations. Deleting a required key is `data.required`.
- `--batch` merges `defaults.data` and each item's `data` by key.

### 2. Body templates

#### Mechanism

The template language is built in, small and logic-free, about 100 lines in `src/render/template.ts`.

- The runtime's only dependency is zod, and `config/starter.ts` parses YAML by line rather than add a package, so Handlebars or Mustache doesn't fit.
- Config knobs alone, such as order and toggles, can't express literal text.

#### Config

`render.prBody: string | string[]`. An array is joined with `\n`. The cap is 4,000 chars. The template lives inline in `.github/ghx.json`, which keeps three things true:

- the remote config path is still one Contents call (`load.ts`);
- `CONFIG_DRIFT` covers the template;
- the `ci wait` config fingerprint covers it too.

`render.mode` (`trailer`, `details`) becomes shorthand for the two built-in templates below. Setting both `mode` and `prBody` is `CONFIG_INVALID` (`render.prBody.conflicts_mode`), because the intent is ambiguous.

#### Grammar

- **Placeholders** are `{{name}}` and `{{data.<key>}}`, substituted in one pass. Values are never scanned again, so a description that contains `{{trailer}}` stays literal.
- **Paragraphs** are split on blank lines. A paragraph whose placeholders all render empty is dropped, which reproduces `joinParagraphs`.
- **Sections:** a heading line (`#` to `######`) starts a section, which runs to the next heading of the same or a higher level, or to the end. A section that has placeholders, all of them empty, is dropped with its heading. A section with only literal text is kept.
- There are no loops, conditionals, partials, filters or escape syntax. Line endings normalise to `\n`.

#### Placeholder vocabulary

| Placeholder | Kind | Renders |
|---|---|---|
| `description` | block, **required** | `block.description` |
| `trailer` | block, **required** | `renderTrailer(block)`: the one metadata line, with `Closes #N` |
| `howToTest` | block | the per-test list (today's `renderHowToTest` items, without the `<details>` wrapper) |
| `data` | block | every data key not placed by a `{{data.<key>}}`: declared keys in config order, then the rest sorted |
| `data.<key>` | inline | one **declared** key's value, empty when absent |
| `risk`, `revertPolicy`, `components`, `testSummary` | inline | the field, as the trailer writes it |
| `riskNote`, `revertNote` | inline | the note, empty when absent |

- A block placeholder must be the only thing in its paragraph, and each placeholder appears at most once.
- `trailer` stays whole on its own line. Drift detection anchors on it, and GitHub's auto-close needs `Closes #N` in visible text.
- The footer (`render.footer`) and the hidden block aren't placeholders. ghx appends them after the template, in that order, so no template can drop or move the block.

#### Validation (when the config loads, as `CONFIG_INVALID` with issue paths)

| Code | Case |
|---|---|
| `render.prBody.unknown_placeholder` | not in the vocabulary (did-you-mean) |
| `render.prBody.undeclared_data_key` | `{{data.k}}` where `k` isn't in `data.fields` |
| `render.prBody.missing_required` | no `{{description}}` or no `{{trailer}}` |
| `render.prBody.repeated` | a placeholder used twice |
| `render.prBody.not_alone` | a block placeholder sharing its paragraph |
| `render.prBody.html_comment` | literal text contains `<!--` |
| `render.prBody.trailer_like` | a literal line matches the trailer pattern |
| `render.prBody.unterminated` | `{{` without `}}` |
| `render.prBody.conflicts_mode` | both `mode` and `prBody` set |
| `render.prBody.in_heading` | a placeholder inside a heading (headings are literal) |
| `render.prBody.too_long` | over 4,000 chars |

A bad template fails every write before any network call, and `ghx doctor` reports it with no extra code. The template adds no input fields, so `--schema` stays stable. `--example` gains one rules line: `body: rendered by this repo's template; preview with --dry-run`.

#### Built-in templates

The built-in templates now have sections. `trailer` (the default):

```
## Summary

{{description}}

{{trailer}}

## Data

{{data}}
```

`details`:

```
## Summary

{{description}}

{{trailer}}

## How to test

{{howToTest}}

## Data

{{data}}
```

A PR with no data has no Data section. Every body still ends with the footer and the block.

### 3. Rendering data

`{{data}}` renders a list, one key per item. `{{data.<key>}}` renders the value alone.

```
- ticket: `ENG-1234`
- rollout: `canary`
- flags: `new-editor`, `fast-sync`
- owner: `team: payments`, `oncall: dana`
```

- **Values always render as code spans,** with a longer backtick fence when a value contains a backtick. That neutralises `@mentions`, `Closes #N` (no stray auto-close) and markdown inside values. Keys match `DataKey`, so they are safe as plain text.
- Arrays join their items with `, `. Objects render as `k: v` items, sorted by key.
- A value that is visible and also in the block counts twice against the 65,536-char body limit. The 2 KB cap bounds that. `META_TOO_LARGE` stays the backstop.

### `layout` and drift (02 §3, §4.1)

Drift detection today parses one fixed layout (`parsePrBody`, `prBodyDrift`). With templates it works by anchors:

1. Every new body records `layout` in the `pr` block: the first 8 hex chars of the sha256 of the normalised template text, built-in templates included.
2. **A body with `layout`:** ghx renders the block under the current template. If the result equals the body, there's no drift. Otherwise:
   - `description` drift: `block.description` is no longer a paragraph of the body;
   - `trailer` drift: `renderTrailer(block)` is no longer a paragraph of the body;
   - `appended` drift: the anchors hold and `layout` matches, but the body differs;
   - `layout` drift (a new, additive enum value): the anchors hold and `layout` differs from the current template.
3. **A body without `layout`** was written before this plan. `parsePrBody` still reads it, unchanged.
4. **`pr edit`:**
   - It always renders under the current template.
   - When `layout` differs or is absent, it warns `TEMPLATE_CHANGED` and the rewrite bumps `rev`. This generalises `FOOTER_REPLACED`.
   - An edit is a no-op, and keeps `rev`, only when the content is unchanged and `layout` matches.
   - `DESCRIPTION_DRIFT` keeps its current behaviour for `description`, `trailer` and `appended` drift.

## Messages

| Case | Code | Text |
|---|---|---|
| Required field missing | `data.required` (issue) | `data.ticket is required by .github/ghx.json (pattern ^ENG-\d+$); did you mean 'tikcet'?` |
| Required by risk | `data.required` (issue) | `data.rollout is required at risk medium and above (.github/ghx.json)` |
| Wrong type or pattern | `data.type` (issue) | `data.rollout must be one of flag, canary, full; got 'all'` |
| Bad key | `data.key` (issue) | `data key 'Ticket ID' must match ^[a-z][a-zA-Z0-9_-]{0,39}$` |
| Too big | `data.too_large` / `data.too_many_keys` (issue) | `data is 2,310 bytes; the limit is 2,048` |
| Secret-like value | `data.secret_like` (issue) | `data.token looks like a credential (ghp_…); data is public` |
| Untrusted author | `UNTRUSTED_DATA` (warning, status) | `meta.data omitted: the PR author (CONTRIBUTOR) is not trusted.` |
| Invalid stored data | `DATA_INVALID` (warning, status) | `the block's data is not an object; read as {}` |
| Template changed | `TEMPLATE_CHANGED` (warning, edit) | `The body was rendered by another template (a1b2c3d4); re-rendered with the current one.` |

## Back-compat

- **The hidden block** stays `ghx:v1`. `data` and `layout` are optional additions, which 02 §9.3 allows, as 06 did with `alsoTouched`.
- **Visible change.** Every new ghx PR body gets sections. Existing PRs keep their bodies until their next `pr edit`, which re-renders them with `TEMPLATE_CHANGED`. Every `test/fixtures/render/*.body.md` golden and 02 §14.2 change on purpose, in one commit.
- **An older ghx reading a new body:**
  - `PrBlockRead` is loose, so `pr status` still reads the block, without `data`.
  - Its `parsePrBody` doesn't know sections, so it reports `description` drift on new bodies.
  - An older `pr edit` drops `data` and re-renders the old layout.
  - The fix is to upgrade. The release notes say so.
- **Config.** Both new keys are optional. Every existing `.github/ghx.json` stays valid and gets the sectioned built-in template.
- **The `description` rules** (`description.markdown_structure`) stay. Sections come from the template, never from agent text.

## Order of work

Each step is its own commit on `main`, with `pnpm check` green. The release waits for all three.

1. **`data`:**
   - input and block schemas, `toPrBlock`, `CONTENT_KEYS`;
   - the `data` config section and its rules;
   - `PrMeta.data` with the trust gate;
   - the edit merge and `--batch`;
   - `--example` and `--schema`.

   Not yet rendered.
2. **Templates:**
   - `src/render/template.ts`: parse, validate, render;
   - `render.prBody` and the `conflicts_mode` check;
   - the built-in templates;
   - `layout`, anchor drift, `TEMPLATE_CHANGED`.
3. **Data rendering:** `{{data}}` and `{{data.<key>}}`, code-span escaping, the Data section in the built-in templates.
4. **Docs:**
   - brief item 5, 02 §2.2, §3, §4.1, §9.2, §14.2 and §15;
   - `docs/agents/commands.md` and the skill;
   - the header comment in `src/render/pr-body.ts`.

## Tests

| Area | Valid | Invalid |
|---|---|---|
| `DataKey` / `DataValue` | scalars, arrays, one-level objects; unicode; `-->` and `<` in values round-trip through the codec | bad key, two-line string, 301 chars, nested object, 21 keys, 2,049 bytes, `ghp_…` |
| Declared fields | `required`, `requiredFromRisk` at and above the floor; agent extra keys pass silently | missing required (with did-you-mean), wrong enum, pattern miss, `requiredFromRisk` below; invalid regex → `CONFIG_INVALID` |
| `toPrBlock` / strict `PrBlock` | `data` kept; `{}` omitted | strict rejects `{}` and bad values |
| `pr edit` merge | set, `null` delete, `data: null`, array replace, `--batch` defaults merged; no-op keeps `rev` | deleting a required key |
| `pr status` | `meta.data` absent → `{}`, present, from untrusted author → `{}` + `UNTRUSTED_DATA`, non-object → `DATA_INVALID`; golden under 16 KB | — |
| Template parser | string and array forms equal; CRLF; empty paragraph and empty section dropped; literal-only section kept; `{{trailer}}` inside a description stays literal | one test per `render.prBody.*` code, with a did-you-mean case |
| Built-in templates | `trailer` and `details` render every fixture input to the new goldens; no Data section without data | — |
| Data rendering | code spans; backtick in a value; `@user` and `Closes #1` inert; arrays and objects | — |
| Drift | create then status → `[]`; UI edit of the description → `description`; appended text → `appended`; template changed → `layout`; legacy body parsed as before | — |
| `pr edit` with a template | layout matches + no content change → no-op; legacy body → `TEMPLATE_CHANGED`, `rev`+1 | — |
| `--example` / `--schema` | with and without declared fields; registry JSON-Schema export | — |
| Size | `META_TOO_LARGE` with a large template and full data | — |

## Decisions

1. **One field, `data`, stored in the block and rendered from it.** A separate free-form markdown channel (`sections: [{heading, body}]`) was rejected. It would bring back the unstructured bodies that `description.markdown_structure` prevents. It would also make drift unparseable, and it would give `pr edit` nothing to re-render from. Agents add short values. The project's template decides the layout.
2. **Data is composable: required fields plus any extras.** `warn` and `refuse` modes for undeclared keys were rejected, per the user. An agent can add more data than the project asks for, never less. Typos surface through the did-you-mean on `data.required`.
3. **A built-in template language, not a dependency.** It has no logic. The rule that drops empty sections and paragraphs replaces `{{#if}}`.
4. **The template lives inline in `ghx.json`.** A separate `.github/ghx/pr-body.md` would read better. It was left out because it costs a second remote fetch and adds a second drift source. It can be added later as `render.prBodyFile`.
5. **Templates cover the PR body only.** A comment's `note` text exists only in its visible body and `pr feedback` returns it, review suggestion fences are GitHub syntax, and both are short.
6. **Data is visible by default, as code spans.** That way a value can't ping anyone, close an issue or inject markdown. A per-key visibility flag in the input was rejected. Placement is the template's job.
7. **Data stays on the PR body for now.** Data on `pr comment` would need its own trust gating in the fold. A later plan can add it.
8. **The trust gate on `meta.data`** is new for the PR body block. Comments are already gated (`src/feedback/fold.ts`). The body is the one place a fork author can write data that agents read.
