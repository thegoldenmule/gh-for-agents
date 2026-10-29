# ghx-impact prototypes

Python reference code behind [../ghx-impact-findings.md](../ghx-impact-findings.md). It is frozen and unmaintained, and serves as the validation target for the TypeScript port in [plan 07](../../plans/07-ghx-eval.md) (M2, M3).

- `schema/`: probes of the transcript format (record types, linkage, turns, timing, background tasks).
- `episodes/episodes.py`: intent episodes. Run `extract`, then `analyze --gap 10`. `report-gap10.md` is its output on the 2026-10-29 corpus.
- `metrics/`: token attribution, units and the metric catalog. `tx.py` is the shared parser; `report2.py`, `waits2.py` and `pr_cycles2.py` produce the matching `.txt` reports. `metric_catalog.json` is v0.1 of the catalog.

The scripts read `~/.claude/projects` directly. To reproduce the reports after retention has deleted those files, extract the archive into a directory and change the `root` path in each script to point at it:

```sh
mkdir -p /tmp/corpus && tar -xzf ~/.ghx-eval/corpus/claude-projects-2026-10-29.tar.gz -C /tmp/corpus
```

The archive holds 2,965 files: every `*.jsonl`, `*.meta.json` and skill-fork file under `~/.claude/projects` on 2026-10-29.
