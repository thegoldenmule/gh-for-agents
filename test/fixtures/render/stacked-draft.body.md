Reads now verify action signatures with the same documentId binding as writes.
Built on the write-path fix, so it targets that branch until it merges.

Risk: low · Components: reactor · Revert: coordinated · Tests: 1/1 pass (unit) · Stacked on #3301 · Split from #3290

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"components":["reactor"],"description":"Reads now verify action signatures with the same documentId binding as writes.\nBuilt on the write-path fix, so it targets that branch until it merges.","gen":"ghx/0.1.0","id":"p_k3m9qa","refs":{"splitFrom":"#3290","stackedOn":"#3301"},"rev":1,"revertPolicy":"coordinated","revertWith":["#3301"],"risk":"low","t":"pr","testing":[{"command":"pnpm --filter @powerhousedao/reactor test -- verify","kind":"unit","result":"pass"}],"title":"feat(reactor): verify signatures on the read path"} -->