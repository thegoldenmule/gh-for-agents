Names with non-ASCII characters were cut at the first multi-byte char, so "café" became "caf".
The slug step now works on code points & keeps names like Q&A, a <-> b and a --> b as typed.

Risk: low · Components: vetra · Revert: revert-safe · Tests: 1/1 pass (unit)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"components":["vetra"],"description":"Names with non-ASCII characters were cut at the first multi-byte char, so \"café\" became \"caf\".\nThe slug step now works on code points \u0026 keeps names like Q\u0026A, a \u003c-\u003e b and a --\u003e b as typed.","gen":"ghx/0.1.0","id":"p_k3m9qa","rev":1,"revertPolicy":"revert-safe","risk":"low","t":"pr","testing":[{"command":"pnpm --filter @powerhousedao/vetra test -- names","kind":"unit","notes":"covers é, 日本語, 🤖 and a --\u003e b","result":"pass"}],"title":"fix(vetra): keep café, 日本語 and 🤖 intact in document names"} -->