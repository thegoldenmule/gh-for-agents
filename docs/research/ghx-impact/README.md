# ghx-impact prototypes

Python reference code behind [../ghx-impact-findings.md](../ghx-impact-findings.md). It is frozen and unmaintained. Its TypeScript port, checked against it, is [`scripts/eval`](../../../scripts/eval) (`pnpm eval`, [plan 07](../../plans/07-ghx-eval.md)) and is the maintained path.

- `schema/`: probes of the transcript format (record types, linkage, turns, timing, background tasks).
- `episodes/episodes.py`: intent episodes. Run `extract`, then `analyze --gap 10`. `report-gap10.md` is its output on the 2026-10-29 corpus.
- `metrics/`: token attribution, units and the metric catalog. `tx.py` is the shared parser; `report2.py`, `waits2.py` and `pr_cycles2.py` produce the matching `.txt` reports. `metric_catalog.json` is v0.1 of the catalog.

The scripts read `~/.claude/projects` directly. The 2026-10-29 corpus they ran on was kept for a while as a compressed archive (2,965 files: every `*.jsonl`, `*.meta.json` and skill-fork file under `~/.claude/projects` that day). The archive has since been deleted, and Claude Code removes sessions after 30 days, so the reports here can no longer be reproduced. To analyse the sessions on disk now, run `pnpm eval` (see plan 07).
