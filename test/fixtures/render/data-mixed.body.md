## Summary

Startup loaded documents one query at a time; it now batches them 100 per query.
Cold start on the staging dataset drops from 41 s to 9 s.

Risk: medium · Components: switchboard · Revert: revert-safe · Tests: 2/3 pass, 1 not-run (unit, benchmark, manual)

## Data

- flags: `new-editor`, `fast-sync`
- note: ``Closes #99 only when `beta` ships``
- owner: `oncall: @dana`, `team: payments`
- rollout: `canary`
- ticket: `ENG-1234`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"components":["switchboard"],"data":{"flags":["new-editor","fast-sync"],"note":"Closes #99 only when `beta` ships","owner":{"oncall":"@dana","team":"payments"},"rollout":"canary","ticket":"ENG-1234"},"description":"Startup loaded documents one query at a time; it now batches them 100 per query.\nCold start on the staging dataset drops from 41 s to 9 s.","gen":"ghx/0.1.0","id":"p_k3m9qa","layout":"67f58f98","rev":1,"revertPolicy":"revert-safe","risk":"medium","riskNote":"A batch that fails now fails all 100 documents in it instead of one.","t":"pr","testing":[{"command":"pnpm --filter @powerhousedao/switchboard test","kind":"unit","result":"pass"},{"command":"pnpm bench:startup","cwd":"apps/switchboard","kind":"benchmark","notes":"41 s to 9 s on the staging dataset","result":"pass"},{"kind":"manual","notes":"no staging snapshot available locally","result":"not-run","steps":["Start switchboard against a staging snapshot","Open the drive list and confirm every drive loads"]}],"title":"perf(switchboard): batch document loads on startup"} -->