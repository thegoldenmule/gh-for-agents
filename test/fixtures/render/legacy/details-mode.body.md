Codegen now emits a typed reducer stub per operation, so model authors get compile errors instead of runtime ones.

Risk: low · Components: codegen · Revert: revert-with-followup · Tests: 3/4 pass, 1 skipped (unit, build, manual, e2e)

<details><summary>How to test</summary>

- unit: `pnpm test -- reducers` in `packages/codegen` (pass)
- build: `pnpm build` (pass)
- manual (pass)
  1. Run ph generate on the todo-list model
  2. Open the generated reducer and remove one case
  3. Confirm tsc reports the missing operation
- e2e: `pnpm e2e -- codegen` (skipped) — the e2e runner needs Docker

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"components":["codegen"],"description":"Codegen now emits a typed reducer stub per operation, so model authors get compile errors instead of runtime ones.","gen":"ghx/0.1.0","id":"p_k3m9qa","rev":1,"revertNote":"Re-run codegen in every model package after reverting.","revertPolicy":"revert-with-followup","risk":"low","t":"pr","testing":[{"command":"pnpm test -- reducers","cwd":"packages/codegen","kind":"unit","result":"pass"},{"command":"pnpm build","kind":"build","result":"pass"},{"kind":"manual","result":"pass","steps":["Run ph generate on the todo-list model","Open the generated reducer and remove one case","Confirm tsc reports the missing operation"]},{"command":"pnpm e2e -- codegen","kind":"e2e","notes":"the e2e runner needs Docker","result":"skipped"}],"title":"feat(codegen): generate typed reducers for document models"} -->