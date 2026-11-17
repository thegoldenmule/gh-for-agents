Reconnecting cleared the cached drive list, so the sidebar went empty until a full reload.
The cache now survives reconnects and is refreshed in place.

Risk: low · Components: connect · Revert: revert-safe · Tests: 2/2 pass (unit, e2e) · Closes #2894, closes #2901, closes powerhouse-inc/connect#88

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"components":["connect"],"description":"Reconnecting cleared the cached drive list, so the sidebar went empty until a full reload.\nThe cache now survives reconnects and is refreshed in place.","gen":"ghx/0.1.0","id":"p_k3m9qa","refs":{"closes":["#2894","#2901","powerhouse-inc/connect#88"]},"rev":1,"revertPolicy":"revert-safe","risk":"low","t":"pr","testing":[{"command":"pnpm --filter @powerhousedao/connect test -- drives","kind":"unit","result":"pass"},{"command":"pnpm --filter @powerhousedao/connect e2e -- reconnect","kind":"e2e","result":"pass"}],"title":"fix(connect): keep the drive list after a reconnect"} -->