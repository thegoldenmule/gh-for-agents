# 06: Wide PRs (more touched components than `components` can list)

This plan amends 02 §2.1 (input and network checks), §2.2 (rendering), §3 (`pr edit`), §4.1 (`PrMeta`) and §9.2 (the `pr` block). It changes nothing else. Read it after `05-handoff.md`.

## Problem

Observed 2026-10-26 on powerhouse-inc/powerhouse#3259, a draft opened without ghx:

- `ghx pr edit 3259` with `{"draft": false}` fails with `NO_BLOCK`. The hint says to adopt the PR with the full object and `"adopt": true`.
- The diff touches 26 components of the repo's `.github/ghx.json`.
- `PrCreateInput.components` is capped at 5 (`MAX_COMPONENTS`, 02 §2.1).
- The network check `components.undeclared_touched` requires every touched component to be declared.

No input satisfies both rules, and there is no override. `pr create` has the same contradiction for any PR that touches more than 5 components.

## What `components` feeds today

| Consumer | Use |
|---|---|
| `createRules` `title.scope_not_declared` | The title scope must be one of `components` |
| `createRules` `risk.below_component_floor` | `risk` ≥ the highest `minRisk` among `components` |
| `createRules` `components.duplicate` / unknown | Unique, and each one is a config component |
| `createNetworkRules` `components.undeclared_touched` | Every component whose `paths` match a changed file is declared |
| `createNetworkRules` `COMPONENTS_UNUSED` | A declared component with `paths` has no changed file |
| `toPrBlock` / the `pr` block | Stored as `components` |
| `renderTrailer` | `Components: a, b` in the one visible trailer line |
| `pr status` `meta.components` | Reported from the block |
| `pr merge` policy | Not used |

So the two rules carry these intents:

- **The cap (5):** `components` is a short, prioritised list the agent chooses, and the trailer stays one compact line (brief 5).
- **The touched rule:** the metadata covers the whole blast radius. In particular, `minRisk` floors apply to every component the diff touches, because the agent cannot skip a component it touches.

## Design: declared primaries plus derived `alsoTouched`

`components` stays the agent's list, capped at 5. ghx derives the rest from the diff and records it.

1. **A PR that touches at most 5 components is validated exactly as before.** Every touched component must be declared, and `components.undeclared_touched` names each one that is not.
2. **Wide PRs.** When the diff touches more than 5 components:
   - with fewer than 5 declared, one `components.undeclared_touched` issue names the count and asks for the 5 primary components (not one issue per component);
   - with 5 declared, the touched components outside `components` are valid. ghx records them in the block as `alsoTouched` and warns `COMPONENTS_ALSO_TOUCHED`.
3. **Risk floors cover `alsoTouched`.** `risk.below_component_floor` is also checked against the `minRisk` of every `alsoTouched` component (a network rule, because only the diff knows the set). Filling `components` with 5 low-floor names cannot hide a `minRisk: high` component.
4. **The agent never writes `alsoTouched`.** It is not an input field. Every `pr create` and `pr edit` derives it again from the diff.

### Schema

`PrCreateInput` and `PrEditInput` are unchanged: `components` is still `min(1).max(5)`. Only its description changes, which is what `--schema` and `ghx schema` print:

```ts
components: z.array(ComponentName).min(1).max(MAX_COMPONENTS)
  .describe('Components from .github/ghx.json: every one the diff touches; past 5, the 5 primary ones (ghx records the rest as alsoTouched)'),
```

The `pr` block (02 §9.2) gains one optional field:

```ts
// strict (write)
alsoTouched: z.array(ComponentName).min(1).optional(),   // touched by the diff, not in components; absent when none
// lenient (read)
alsoTouched: z.array(ComponentRead).optional(),
```

- It is absent when empty, as `revertWith` is, so a PR that is not wide gets a byte-identical block and body.
- Order follows the config's `components` record, the order `touchedComponents` already returns.

`PrMeta` (`pr status`, 02 §4.1) gains `alsoTouched: string[]`, `[]` when the block has none, so the output shape is stable.

### Config

No config change. `.github/ghx.json` keeps `version: 1`; `paths` and `minRisk` already carry everything the derivation needs. A component without `paths` never matches a file, so it is never in `alsoTouched` (unchanged from `touchedComponents`).

### Rendering (02 §2.2)

The trailer lists the declared components, then the derived count:

```
Risk: high · Components: reactor, shared, reactor-browser, reactor-api, document-model (+21 more) · Revert: forward-fix-only · Tests: 6/7 pass, 1 fail (typecheck, lint, unit)
```

The names stay in the hidden block, so the visible body stays one line however wide the PR is. `parsePrBody`'s trailer pattern is unchanged. `prBodyDrift` and `pr edit`'s no-op check render the trailer from the block, `alsoTouched` included, so an unchanged wide PR reports no drift and keeps its `rev`.

### `pr edit` (02 §3)

- `alsoTouched` is not a content key. `blockContent` drops it and the merged object is validated as before. The edit derives it again from the current diff, so a push that narrows the diff shrinks it.
- When the changed files are unknown (over 300 files and no local checkout, `COMPONENTS_UNCHECKED`), the edit keeps the block's previous `alsoTouched`, minus names now in `components` or no longer in the config. Otherwise, an edit that cannot see the diff would drop the record.
- The `NO_BLOCK` adoption hint says `components` takes the primary components, up to 5.

### Messages

| Case | Code | Text |
|---|---|---|
| Touches ≤ 5, some undeclared | `components.undeclared_touched` (issue) | Unchanged: `the PR changes shared (libs/common/x.ts, …); add 'shared' to components` |
| Wide, fewer than 5 declared | `components.undeclared_touched` (issue) | `the PR touches 26 components, more than components can list (5); declare the 5 primary ones and ghx records the rest as alsoTouched (undeclared: connect, apps-switchboard, ph-cli, +20 more)` |
| Wide, 5 declared | `COMPONENTS_ALSO_TOUCHED` (warning) | `The PR also touches 21 components beyond the 5 declared; recorded as alsoTouched: connect, apps-switchboard, ph-cli, +18 more.` |
| Floor set by a derived component | `risk.below_component_floor` (issue) | `risk 'low' is below the floor set by host-core (high), which the PR also touches, in .github/ghx.json` |

Warnings list at most 3 names, then a count, so their length is bounded.

### Back-compat

- **Hidden block.** The marker stays `ghx:v1`. 02 §9.3 allows optional fields in v1. A `ghx:v2` marker would make every installed ghx read the block as `SCHEMA_NEWER`, and `pr edit` would refuse those PRs with a `NO_BLOCK` that cannot be adopted.
- **Older ghx reading a new block.** `PrBlockRead` is a loose object, so `pr status` still reads it, without `alsoTouched`. Its trailer drift check reports `trailer` on a wide PR, because it renders without the count. An older `pr edit` drops `alsoTouched` and then fails `components.undeclared_touched` on a wide PR, as it does today. That is no regression, and the fix is to upgrade.
- **Existing blocks.** A block without `alsoTouched` reads as `[]`. Bodies of PRs that are not wide re-render unchanged, so `rev` does not move.
- **Config.** No new keys; every existing `.github/ghx.json` stays valid.
- **`rev` and `gen`.** Unchanged semantics: `rev` goes up only when the body changes, and `gen` records the writer.

## Tests

| Area | Case | Valid | Invalid |
|---|---|---|---|
| `createNetworkRules` | touches ≤ 5 | all declared | one undeclared: per-component issue (existing test); 5 declared with one unrelated and one touched missing: still per-component, nothing recorded |
| | wide, room left | — | 2 declared of 7 touched: one issue with the count and first 3 names, `alsoTouched` empty |
| | wide, full | 5 declared of 7 touched: no issue, `alsoTouched` the 2 others in config order, warning `COMPONENTS_ALSO_TOUCHED` | — |
| | floor via `alsoTouched` | risk at the derived component's floor | risk below it: `risk.below_component_floor` naming the component |
| | unchecked | — | `changedFiles: null`: `alsoTouched` empty, `COMPONENTS_UNCHECKED` (existing) |
| `toPrBlock` / strict `PrBlock` | | `alsoTouched` given, kept; `[]`, omitted | strict schema rejects `[]` |
| `renderTrailer` | | `(+N more)` after the names; no suffix when absent | — |
| Render fixtures | | every `test/fixtures/render/*.body.md` unchanged | — |
| `pr status` | | `meta.alsoTouched` from the block, `[]` when absent; golden updated | — |
| `pr create` command | | a 6-component diff with 5 declared creates a PR whose block has `alsoTouched` | — |
| `pr edit` command | adopt | a wide PR without a block, adopted with 5 primaries and `draft:false`: block written with `alsoTouched`, draft flipped | adoption with 2 primaries: `VALIDATION`, one wide issue |
| | no-op | re-running an edit on an unchanged wide PR keeps `rev` and the body | — |

## Decisions

1. **Derive the remainder rather than raise the cap.** A per-repo `create.maxComponents` was rejected: #3259 would need a 26-name list written by hand, and the trailer would carry all 26. Agents should not enumerate what ghx can derive from the diff, and the body must stay compact.
2. **No wide marker.** A `"wide": true` flag or a `*` component was rejected: it drops which components were touched, and with it the risk floors.
3. **The touched rule still applies whenever the touched set fits in 5.** The alternative was to always derive, so `components` would only be the primaries even for a 2-component PR. That changes the contract for every small PR and hides a forgotten component behind a warning. With this rule the behaviour changes only where no valid input existed before. Choosing "always derive" later is a rule change in `createNetworkRules` alone, because the block field and the trailer would stay the same.
4. **A full list (5) is required before ghx records the rest.** Without that, an agent could declare 1 component on a 26-component PR. Filling the list to the cap matches the touched rule's intent as closely as the cap allows.
5. **`alsoTouched` stores only the undeclared names**, not the whole touched set. Then the block is unchanged for PRs that are not wide, and nothing is stored twice.
