Bind the document id before dispatching so retries reuse it. Fixes the duplicate-insert race seen in #3184.

`risk: low · components: reactor · revert: revert-safe · tests: 2/2 pass`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- ghx:v1 {"components":["reactor"],"description":"Bind the document id before dispatching so retries reuse it.","gen":"ghx/0.1.0","id":"p_k3m9qa","rev":1,"risk":"low","t":"pr","title":"fix(reactor): bind document id before dispatch <v2> & retry"} -->
