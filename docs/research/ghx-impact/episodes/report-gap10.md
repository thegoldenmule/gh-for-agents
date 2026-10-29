# episodes.py report (gap=10 min)

## Adoption (first non-meta ghx call, non-dev projects)
- powerhouse-powerhouse: 2026-10-23T18:39:39.227Z

## Calls by project x side
| project                           | gh   | ghx | mixed |
|-----------------------------------|------|-----|-------|
| powerhouse-powerhouse             | 1213 | 714 | 0     |
| thegoldenmule-gh-for-agents [dev] | 137  | 204 | 7     |
| powerhouse-recipes                | 296  | 0   | 0     |
| powerhouse-sektar                 | 92   | 0   | 0     |
| powerhouse-bai-knowledge-note     | 17   | 0   | 0     |
| thegoldenmule-claude-watcher      | 10   | 0   | 0     |
| thegoldenmule-powerhouse-nl       | 9    | 0   | 0     |
| thegoldenmule-thegoldenmule       | 7    | 0   | 0     |

## Calls by ISO week x side (non-dev)
| week     | gh  | ghx | mixed |
|----------|-----|-----|-------|
| 2026-W39 | 64  | 0   | 0     |
| 2026-W40 | 179 | 0   | 0     |
| 2026-W41 | 421 | 0   | 0     |
| 2026-W42 | 355 | 0   | 0     |
| 2026-W43 | 507 | 87  | 0     |
| 2026-W44 | 118 | 627 | 0     |

ghx calls (non-dev) by kind: {'native': 514, 'meta': 73, 'passthrough': 127}
ghx subcommands (non-dev): ghx ci wait 184, ghx pr status 124, ghx pr create 99, ghx pr merge 44, ghx ci rerun 41, ghx schema pr 33, ghx pr edit 33, ghx run list 30, ghx run view 30, ghx ci why 30, ghx pr view 12, ghx pr diff 12, ghx 2> 11, ghx api repos/powerhouse-inc/powerhouse/actions/jobs/$id/logs 4, ghx api repos/powerhouse-inc/powerhouse/actions/jobs/$j/logs 3, ghx schema "" 3, ghx pr list 3, ghx api '' 3, ghx api repos/powerhouse-inc/powerhouse/actions/jobs/122427086643/logs 2, ghx --help 2, ghx api repos/powerhouse-inc/powerhouse/pulls/3314 2, ghx api repos/powerhouse-inc/powerhouse/actions/jobs/121825059450 2, ghx api repos/powerhouse-inc/powerhouse/pulls/3285 2, ghx pr checks 1, ghx ci 2> 1

## Episodes (non-dev): 1439 total; side: {'gh': 954, 'ghx': 450, 'meta': 32, 'mixed': 3}
closed_by: [('tool', 980), ('notification', 285), ('prompt', 85), ('gap', 40), ('TaskStop', 20), ('eof', 14), ('censored', 14), ('compact', 1)]
| intent      | side  | n   | calls p50 | calls p90 | chars p50 | chars p90 | authored p50 | secs p50 | secs p90 | %w/ error | %sub |
|-------------|-------|-----|-----------|-----------|-----------|-----------|--------------|----------|----------|-----------|------|
| merge       | gh    | 45  | 2.0       | 4.6       | 208       | 1,520     | 647          | 20       | 378      | 0%        | 51%  |
| merge       | ghx   | 29  | 2.0       | 4.0       | 913       | 5,116     | 88           | 15       | 34       | 10%       | 38%  |
| create      | gh    | 55  | 1.0       | 2.0       | 148       | 538       | 958          | 5        | 15       | 0%        | 47%  |
| create      | ghx   | 37  | 3.0       | 4.0       | 5,634     | 9,890     | 1,997        | 15       | 24       | 51%       | 100% |
| edit        | gh    | 46  | 1.0       | 3.0       | 234       | 1,634     | 936          | 8        | 85       | 0%        | 63%  |
| edit        | ghx   | 17  | 3.0       | 4.0       | 5,551     | 8,762     | 814          | 14       | 34       | 47%       | 76%  |
| reply       | gh    | 1   | 2.0       | 2.0       | 314       | 314       | 2,840        | 5        | 5        | 0%        | 100% |
| other_write | gh    | 4   | 5.0       | 8.7       | 4,573     | 11,114    | 1,326        | 23       | 54       | 25%       | 50%  |
| diagnose    | gh    | 174 | 3.0       | 6.0       | 3,659     | 16,681    | 928          | 19       | 101      | 4%        | 60%  |
| diagnose    | ghx   | 42  | 2.0       | 5.0       | 1,842     | 9,097     | 438          | 11       | 31       | 21%       | 79%  |
| rerun       | gh    | 24  | 1.0       | 3.0       | 202       | 1,512     | 437          | 7        | 105      | 4%        | 54%  |
| rerun       | ghx   | 21  | 2.0       | 2.0       | 1,419     | 3,117     | 167          | 6        | 445      | 33%       | 100% |
| rerun       | mixed | 1   | 5.0       | 5.0       | 4,192     | 4,192     | 563          | 2,242    | 2,242    | 0%        | 0%   |
| wait        | gh    | 170 | 1.0       | 2.0       | 1,192     | 2,204     | 491          | 645      | 1,890    | 1%        | 67%  |
| wait        | ghx   | 183 | 2.0       | 3.0       | 1,894     | 2,732     | 189          | 1,262    | 2,705    | 1%        | 85%  |
| wait        | mixed | 1   | 8.0       | 8.0       | 13,776    | 13,776    | 937          | 190      | 190      | 0%        | 100% |
| feedback    | gh    | 12  | 1.0       | 3.8       | 2,520     | 25,213    | 286          | 4        | 24       | 0%        | 58%  |
| feedback    | ghx   | 1   | 2.0       | 2.0       | 4,025     | 4,025     | 38           | 9        | 9        | 0%        | 100% |
| status      | gh    | 285 | 1.0       | 2.0       | 581       | 3,247     | 328          | 3        | 14       | 1%        | 55%  |
| status      | ghx   | 110 | 1.0       | 2.0       | 1,759     | 5,929     | 136          | 4        | 13       | 7%        | 77%  |
| status      | mixed | 1   | 2.0       | 2.0       | 6,274     | 6,274     | 221          | 5        | 5        | 0%        | 100% |
| other_read  | gh    | 138 | 1.0       | 3.0       | 2,063     | 15,995    | 400          | 4        | 19       | 4%        | 81%  |
| other_read  | ghx   | 10  | 1.0       | 1.1       | 544       | 7,539     | 28           | 1        | 3        | 40%       | 100% |

## Episodes in powerhouse-powerhouse, by era x side
| intent      | era     | side  | n   | calls p50 | calls p90 | chars p50 | chars p90 | authored p50 | secs p50 | secs p90 | %w/ error | %sub |
|-------------|---------|-------|-----|-----------|-----------|-----------|-----------|--------------|----------|----------|-----------|------|
| merge       | gh-era  | gh    | 37  | 2.0       | 4.4       | 171       | 2,102     | 692          | 20       | 407      | 0%        | 43%  |
| merge       | ghx-era | ghx   | 29  | 2.0       | 4.0       | 913       | 5,116     | 88           | 15       | 34       | 10%       | 38%  |
| create      | gh-era  | gh    | 49  | 1.0       | 2.0       | 139       | 456       | 892          | 6        | 14       | 0%        | 43%  |
| create      | ghx-era | ghx   | 37  | 3.0       | 4.0       | 5,634     | 9,890     | 1,997        | 15       | 24       | 51%       | 100% |
| edit        | gh-era  | gh    | 32  | 1.0       | 2.9       | 234       | 1,416     | 872          | 8        | 268      | 0%        | 50%  |
| edit        | ghx-era | ghx   | 17  | 3.0       | 4.0       | 5,551     | 8,762     | 814          | 14       | 34       | 47%       | 76%  |
| reply       | gh-era  | gh    | 1   | 2.0       | 2.0       | 314       | 314       | 2,840        | 5        | 5        | 0%        | 100% |
| other_write | gh-era  | gh    | 1   | 9.0       | 9.0       | 8,789     | 8,789     | 2,931        | 63       | 63       | 0%        | 100% |
| diagnose    | gh-era  | gh    | 137 | 3.0       | 6.0       | 4,115     | 17,876    | 928          | 18       | 62       | 5%        | 54%  |
| diagnose    | ghx-era | gh    | 1   | 2.0       | 2.0       | 1,784     | 1,784     | 654          | 8        | 8        | 0%        | 0%   |
| diagnose    | ghx-era | ghx   | 42  | 2.0       | 5.0       | 1,842     | 9,097     | 438          | 11       | 31       | 21%       | 79%  |
| rerun       | gh-era  | gh    | 21  | 1.0       | 3.0       | 193       | 1,522     | 440          | 7        | 111      | 5%        | 48%  |
| rerun       | ghx-era | ghx   | 21  | 2.0       | 2.0       | 1,419     | 3,117     | 167          | 6        | 445      | 33%       | 100% |
| rerun       | ghx-era | mixed | 1   | 5.0       | 5.0       | 4,192     | 4,192     | 563          | 2,242    | 2,242    | 0%        | 0%   |
| wait        | gh-era  | gh    | 126 | 1.0       | 2.0       | 1,108     | 1,837     | 494          | 667      | 1,876    | 1%        | 59%  |
| wait        | ghx-era | ghx   | 183 | 2.0       | 3.0       | 1,894     | 2,732     | 189          | 1,262    | 2,705    | 1%        | 85%  |
| wait        | ghx-era | mixed | 1   | 8.0       | 8.0       | 13,776    | 13,776    | 937          | 190      | 190      | 0%        | 100% |
| feedback    | gh-era  | gh    | 12  | 1.0       | 3.8       | 2,520     | 25,213    | 286          | 4        | 24       | 0%        | 58%  |
| feedback    | ghx-era | ghx   | 1   | 2.0       | 2.0       | 4,025     | 4,025     | 38           | 9        | 9        | 0%        | 100% |
| status      | gh-era  | gh    | 190 | 1.0       | 2.0       | 564       | 3,238     | 327          | 3        | 14       | 1%        | 46%  |
| status      | ghx-era | gh    | 2   | 2.0       | 2.8       | 3,802     | 6,794     | 442          | 14       | 20       | 0%        | 100% |
| status      | ghx-era | ghx   | 110 | 1.0       | 2.0       | 1,759     | 5,929     | 136          | 4        | 13       | 7%        | 77%  |
| status      | ghx-era | mixed | 1   | 2.0       | 2.0       | 6,274     | 6,274     | 221          | 5        | 5        | 0%        | 100% |
| other_read  | gh-era  | gh    | 85  | 1.0       | 3.0       | 3,197     | 16,160    | 408          | 4        | 15       | 5%        | 86%  |
| other_read  | ghx-era | gh    | 5   | 1.0       | 1.6       | 697       | 3,347     | 498          | 2        | 15       | 0%        | 100% |
| other_read  | ghx-era | ghx   | 10  | 1.0       | 1.1       | 544       | 7,539     | 28           | 1        | 3        | 40%       | 100% |

## Same, opus-5-5 only, powerhouse-powerhouse (model held constant)
| intent     | side | n   | calls p50 | calls p90 | chars p50 | chars p90 | authored p50 | secs p50 | secs p90 | %w/ error | %sub |
|------------|------|-----|-----------|-----------|-----------|-----------|--------------|----------|----------|-----------|------|
| merge      | gh   | 35  | 2.0       | 4.6       | 171       | 2,388     | 655          | 20       | 410      | 0%        | 46%  |
| merge      | ghx  | 29  | 2.0       | 4.0       | 913       | 5,116     | 88           | 15       | 34       | 10%       | 38%  |
| create     | gh   | 44  | 1.0       | 2.0       | 134       | 433       | 890          | 5        | 13       | 0%        | 48%  |
| create     | ghx  | 37  | 3.0       | 4.0       | 5,634     | 9,890     | 1,997        | 15       | 24       | 51%       | 100% |
| edit       | gh   | 29  | 1.0       | 3.0       | 239       | 1,539     | 866          | 7        | 287      | 0%        | 55%  |
| edit       | ghx  | 17  | 3.0       | 4.0       | 5,551     | 8,762     | 814          | 14       | 34       | 47%       | 76%  |
| reply      | gh   | 1   | 2.0       | 2.0       | 314       | 314       | 2,840        | 5        | 5        | 0%        | 100% |
| diagnose   | gh   | 131 | 3.0       | 6.0       | 4,115     | 17,466    | 895          | 17       | 58       | 5%        | 56%  |
| diagnose   | ghx  | 42  | 2.0       | 5.0       | 1,842     | 9,097     | 438          | 11       | 31       | 21%       | 79%  |
| rerun      | gh   | 15  | 1.0       | 2.0       | 96        | 502       | 394          | 4        | 61       | 7%        | 67%  |
| rerun      | ghx  | 21  | 2.0       | 2.0       | 1,419     | 3,117     | 167          | 6        | 445      | 33%       | 100% |
| wait       | gh   | 118 | 1.0       | 2.3       | 1,102     | 1,745     | 496          | 561      | 1,873    | 1%        | 63%  |
| wait       | ghx  | 183 | 2.0       | 3.0       | 1,894     | 2,732     | 189          | 1,262    | 2,705    | 1%        | 85%  |
| feedback   | gh   | 7   | 1.0       | 2.8       | 2,717     | 20,558    | 420          | 4        | 16       | 0%        | 71%  |
| feedback   | ghx  | 1   | 2.0       | 2.0       | 4,025     | 4,025     | 38           | 9        | 9        | 0%        | 100% |
| status     | gh   | 186 | 1.0       | 2.0       | 528       | 3,324     | 332          | 3        | 14       | 1%        | 48%  |
| status     | ghx  | 110 | 1.0       | 2.0       | 1,759     | 5,929     | 136          | 4        | 13       | 7%        | 77%  |
| other_read | gh   | 76  | 1.0       | 3.0       | 3,694     | 17,298    | 352          | 4        | 12       | 3%        | 84%  |
| other_read | ghx  | 10  | 1.0       | 1.1       | 544       | 7,539     | 28           | 1        | 3        | 40%       | 100% |

## Wait episodes (non-dev): kind, wakeups, glue
| side  | kind       | n   | wakeups p50 | wakeups p90 | notif chars p50 | glue p50 | censored | monitor |
|-------|------------|-----|-------------|-------------|-----------------|----------|----------|---------|
| gh    | wait_bg    | 137 | 1.0         | 3.4         | 678             | 0.0      | 10       | 48      |
| gh    | contiguous | 33  | 0.0         | 0.0         | 0               | 0.0      | 0        | 0       |
| ghx   | wait_bg    | 182 | 1.0         | 1.0         | 899             | 1.0      | 4        | 0       |
| ghx   | contiguous | 1   | 0.0         | 0.0         | 0               | 0.0      | 0        | 0       |
| mixed | contiguous | 1   | 0.0         | 0.0         | 0               | 0.0      | 0        | 0       |

## Segmentation diagnostics (non-dev)
- multi-PR episodes: 77 (5%)
- episodes with no PR number: 488
- single-call episodes: 737
- episodes with glue calls: 287; glue calls total 350
- wait episodes spanning a compaction: 0
- episodes containing ghx meta (help/schema) calls: 62
- mixed-side episodes: 3
- contiguous episodes closed by: [('tool:Bash', 749), ('prompt', 85), ('tool:SubagentHandback', 57), ('tool:SendMessage', 48), ('tool:Write', 48), ('gap', 40), ('tool:Agent', 37), ('eof', 14)]

## Validation: gh-side Bash/Monitor calls with ts < 2026-10-23: 1627; invocations: 2573
- gh CI episodes before 10-23 (all projects): 701, with log fetch 185, median gh calls of those 3.0

## ghx friction (non-dev)
- ghx calls (any): 714
- ghx non-zero exit codes: {2: 36, 9: 8, 1: 5, 7: 1, 3: 1}
- ghx error codes in results: {'VALIDATION': 32, 'USAGE_UNKNOWN_COMMAND': 23, 'USAGE_UNKNOWN_FLAG': 5, 'RUN_IN_PROGRESS': 5, 'NO_FLAKY_CANDIDATES': 2, 'DIFF_TOO_LARGE': 2, 'NO_BLOCK': 1, 'USAGE_INPUT_CONFLICT': 1, 'MERGE_BLOCKED': 1, 'USAGE_BAD_SELECTOR': 1, 'CONFIG_MISSING': 1, 'PASSTHROUGH_WRITE_REFUSED': 1}
- policy refusals (exit 6): 0
- user-rejected gh/ghx calls: Counter({'ghx': 3, 'gh': 2})
- hook nudges/denials (by reason, side of denied call): {('hook_replace', 'gh'): 3, ('hook_poll', 'ghx'): 2, ('hook_write_denied', 'gh'): 1}
- after hook / ghx error (next GitHub call within 10 min): {('ghx-error', 'next=ghx/same-intent'): 50, ('ghx-error', 'next=ghx/other-intent'): 21, ('hook', 'next=gh/same-intent'): 1, ('hook', 'next=ghx/other-intent'): 2, ('hook', 'no follow-up'): 1, ('ghx-error', 'no follow-up'): 5, ('hook', 'next=ghx/same-intent'): 2}
- ghx-error -> raw gh fallback examples: []

## Confounders (non-dev episodes)

powerhouse-powerhouse episodes by ver (rows with >=3):
| ver     | gh-era gh | gh-era ghx | gh-era mixed | ghx-era gh | ghx-era ghx | ghx-era mixed |
|---------|-----------|------------|--------------|------------|-------------|---------------|
| 2.1.280 | 691       | 0          | 0            | 8          | 450         | 3             |

powerhouse-powerhouse episodes by model (rows with >=3):
| model            | gh-era gh | gh-era ghx | gh-era mixed | ghx-era gh | ghx-era ghx | ghx-era mixed |
|------------------|-----------|------------|--------------|------------|-------------|---------------|
| claude-fable-5-1 | 52        | 0          | 0            | 0          | 0           | 0             |
| claude-opus-5-5  | 634       | 0          | 0            | 8          | 450         | 3             |
| claude-sonnet-5  | 5         | 0          | 0            | 0          | 0           | 0             |

Episodes by project x era x side:
| project                       | gh-era gh | gh-era ghx | gh-era mixed | ghx-era gh | ghx-era ghx | ghx-era mixed |
|-------------------------------|-----------|------------|--------------|------------|-------------|---------------|
| powerhouse-bai-knowledge-note | 9         | 0          | 0            | 0          | 0           | 0             |
| powerhouse-powerhouse         | 691       | 0          | 0            | 8          | 450         | 3             |
| powerhouse-recipes            | 178       | 0          | 0            | 0          | 0           | 0             |
| powerhouse-sektar             | 53        | 0          | 0            | 0          | 0           | 0             |
| thegoldenmule-claude-watcher  | 8         | 0          | 0            | 0          | 0           | 0             |
| thegoldenmule-powerhouse-nl   | 5         | 0          | 0            | 0          | 0           | 0             |
| thegoldenmule-thegoldenmule   | 2         | 0          | 0            | 0          | 0           | 0             |

Episodes by era x main/subagent:
| era     | who      | gh  | ghx | mixed |
|---------|----------|-----|-----|-------|
| gh-era  | main     | 364 | 0   | 0     |
| gh-era  | subagent | 582 | 0   | 0     |
| ghx-era | main     | 1   | 84  | 1     |
| ghx-era | subagent | 7   | 366 | 2     |

powerhouse-powerhouse episodes by cwd kind (ghx.json lived only in the main checkout at first):
| era     | cwd                   | gh  | ghx | mixed |
|---------|-----------------------|-----|-----|-------|
| gh-era  | main-checkout/unknown | 412 | 0   | 0     |
| gh-era  | worktree              | 279 | 0   | 0     |
| ghx-era | main-checkout/unknown | 5   | 363 | 3     |
| ghx-era | worktree              | 3   | 87  | 0     |

CI episodes: red-CI-seen proxy (difficulty):
| era     | side  | green/unknown | red seen |
|---------|-------|---------------|----------|
| gh-era  | gh    | 460           | 190      |
| gh-era  | ghx   | 0             | 0        |
| gh-era  | mixed | 0             | 0        |
| ghx-era | gh    | 3             | 0        |
| ghx-era | ghx   | 187           | 169      |
| ghx-era | mixed | 0             | 3        |

## CI cycles (per transcript x PR, split at git push)
| era     | side  | cycles | calls p50 | calls p90 | chars p50 | chars p90 | secs p50 | wakeups p50 | w/ merge |
|---------|-------|--------|-----------|-----------|-----------|-----------|----------|-------------|----------|
| gh-era  | gh    | 327    | 2.0       | 8.0       | 1,135     | 10,934    | 20       | 0.0         | 49       |
| gh-era  | mixed | 1      | 7.0       | 7.0       | 4,644     | 4,644     | 6,690    | 1.0         | 0        |
| ghx-era | gh    | 1      | 2.0       | 2.0       | 316       | 316       | 10       | 0.0         | 0        |
| ghx-era | ghx   | 196    | 1.0       | 4.0       | 1,620     | 5,604     | 1,291    | 1.0         | 28       |
| ghx-era | mixed | 3      | 5.0       | 9.0       | 2,833     | 13,251    | 1,995    | 1.0         | 0        |

## PR lifecycles (per session incl. subagents x PR; all GitHub calls naming that PR)
| scope                     | side  | PRs | calls p50 | calls p90 | chars p50 | chars p90 | wakeups p50 | hours p50 | CI rounds p50 | calls/round p50 | chars/round p50 | % calls in subagents |
|---------------------------|-------|-----|-----------|-----------|-----------|-----------|-------------|-----------|---------------|-----------------|-----------------|----------------------|
| all                       | gh    | 127 | 6.0       | 27.0      | 5,602     | 38,860    | 0.0         | 1.05      | 3.0           | 1.8             | 1,411           | 57%                  |
| all                       | ghx   | 37  | 15.0      | 33.0      | 15,913    | 48,064    | 3.0         | 1.46      | 5.0           | 2.5             | 2,798           | 65%                  |
| all                       | mixed | 4   | 26.0      | 50.6      | 36,284    | 50,193    | 5.0         | 2.82      | 5.5           | 4.5             | 4,872           | 42%                  |
| created+merged in session | gh    | 28  | 13.0      | 27.0      | 15,990    | 34,725    | 1.5         | 4.22      | 12.5          | 1.1             | 1,161           | 60%                  |
| created+merged in session | ghx   | 24  | 17.5      | 35.8      | 19,805    | 53,998    | 3.5         | 1.57      | 5.0           | 3.2             | 3,290           | 63%                  |
| created+merged in session | mixed | 2   | 26.0      | 30.0      | 36,284    | 37,533    | 5.5         | 2.82      | 5.5           | 4.8             | 6,678           | 69%                  |

## Example episodes

### diagnose / gh (174 episodes)
- 2026-09-24T15:41 powerhouse-powerhouse (sub) kind=contiguous calls=6 chars=64845 secs=28 wakeups=0 prs=[3088] closed_by=tool:Bash
    - [other_read] `cd ~/.worktrees/powerhouse/action-signature-integrity && git log --oneline -5 && git statu…` -> 9121 chars exit=0
    - [diagnose] `cd ~/.worktrees/powerhouse/action-signature-integrity && gh run view 36020217959 --job 107…` -> 80 chars exit=0
    - [diagnose] `cd ~/.worktrees/powerhouse/action-signature-integrity && gh run view 36020218003 --job 107…` -> 15515 chars exit=0
    - [diagnose] `cd ~/.worktrees/powerhouse/action-signature-integrity && gh run view 36020218003 --job 107…` -> 21107 chars exit=0
    - [diagnose] `cd ~/.worktrees/powerhouse/action-signature-integrity && sed -n 540,740p test/codegen/test…` -> 6467 chars exit=0
    - [diagnose] `cd ~/.worktrees/powerhouse/action-signature-integrity && gh run view 36020218003 --job 107…` -> 12555 chars exit=0
- 2026-10-08T16:54 powerhouse-powerhouse (sub) kind=contiguous calls=3 chars=1469 secs=511 wakeups=0 prs=[3196] closed_by=tool:Bash
    - [status] `for r in 37809450518 37809460566; do until [ "$(gh run view $r --json status --jq .status)" = completed ]; do …` -> 59 chars exit=0
    - [diagnose] `S=/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/2c78e9b7-c4c5-4f87-bd95-ac331d7…` -> 650 chars exit=0
    - [status] `gh pr checks 3196 --json name,bucket,link --jq '.[]|"\(.bucket) \(.name)"' | sort | head -30` -> 760 chars exit=0
- 2026-10-13T22:44 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=8071 secs=5 wakeups=0 prs=[] closed_by=tool:Bash
    - [diagnose] `S=/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/536fb120-df58-4e1b-bee8-b458a6c…` -> 8071 chars exit=0
- 2026-10-29T13:59 thegoldenmule-powerhouse-nl kind=contiguous calls=2 chars=2770 secs=13 wakeups=0 prs=[] closed_by=tool:SendMessage
    - [status] `gh run list --limit 4 2>&1 | cut -f1,2,3,5 | head; git log --oneline origin/main..HEAD | head` -> 986 chars exit=0
    - [diagnose] `id=$(gh run list --limit 1 --json databaseId -q '.[0].databaseId'); gh run view $id --log-failed 2>&1 | grep -…` -> 1784 chars exit=0

### diagnose / ghx (42 episodes)
- 2026-10-23T21:46 powerhouse-powerhouse (sub) kind=contiguous calls=3 chars=8586 secs=10 wakeups=0 prs=[] closed_by=tool:Bash
    - [status] `ghx run list -w "Check Windows" -b feat/switchboard-bound-port -L 5 --json databaseId,conclusion,headSha,attem…` -> 589 chars exit=0
    - [status] `ghx api repos/powerhouse-inc/powerhouse/actions/runs/40015092395/jobs` -> 7589 chars exit=0
    - [diagnose] `ghx ci logs --help 2>&1 | head -c 400; echo; ghx api repos/powerhouse-inc/powerhouse/actions/jobs/120625000284…` -> 408 chars exit=0
- 2026-10-27T14:54 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=245 secs=3 wakeups=0 prs=[] closed_by=tool:Bash
    - [diagnose] `cd ~/.worktrees/powerhouse/v8-wasm-wrapper-tiering && ghx api repos/powerhouse-inc/powerhouse/actions/jobs/122…` -> 245 chars exit=0
- 2026-10-27T17:50 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=1293 secs=26 wakeups=0 prs=[] closed_by=tool:Bash
    - [diagnose] `cd ~/.worktrees/powerhouse/studio-reload-test && S=/private/tmp/claude-501/-Users-benjaminjordan-projects-powe…` -> 1293 chars exit=0
- 2026-10-28T22:49 powerhouse-powerhouse kind=contiguous calls=5 chars=3651 secs=21 wakeups=0 prs=[] closed_by=tool:Bash
    - [diagnose] `ghx ci why branch:main --brief` -> 579 chars exit=0
    - [meta] `ghx ci rerun --help 2>&1 | head -20` -> 2671 chars exit=0
    - [status] `ghx run list --branch main --workflow academy.yml --limit 2 --fields 'passthrough.json[].databaseId,passthroug…` -> 18 chars exit=0
    - [other_read] `ghx api 'repos/powerhouse-inc/powerhouse/actions/jobs/123138215626' --fields passthrough.json.run_id,passthrou…` -> 101 chars exit=0
    - [rerun] `ghx ci rerun run:40779782545 --expect-head e18e3b97ed5b5b991c44d2df18755a160443a782 --brief` -> 282 chars exit=0

### wait / gh (170 episodes)
- 2026-09-24T16:48 powerhouse-powerhouse kind=wait_bg calls=1 chars=1021 secs=1445 wakeups=2 prs=[3088] closed_by=notification:completed
    - [wait,bg,loop] `cd ~/projects/powerhouse/powerhouse; prev=""; while true; do s=$(gh pr checks 3088 --json …` -> 302 chars exit=0
- 2026-10-09T15:45 powerhouse-powerhouse (sub) kind=wait_bg calls=1 chars=733 secs=129 wakeups=1 prs=[3198] closed_by=notification:completed
    - [wait,bg,loop] `until gh pr checks 3198 --json bucket --jq 'all(.bucket!="pending")' 2>/dev/null | grep -q true && [ "$(gh pr …` -> 308 chars exit=0
- 2026-10-20T16:02 powerhouse-sektar (sub) kind=contiguous calls=1 chars=34 secs=17 wakeups=0 prs=[3258] closed_by=tool:Write
    - [wait,loop] `cd ~/.worktrees/powerhouse/host-icons && for i in 1 2 3 4 5 6; do m=$(gh pr view 3258 --js…` -> 34 chars exit=0
- 2026-10-29T14:04 thegoldenmule-powerhouse-nl kind=contiguous calls=1 chars=21 secs=126 wakeups=0 prs=[] closed_by=tool:Bash
    - [wait,loop] `pnpm lint >/dev/null 2>&1; echo lint-exit=$?; git push -q 2>&1|tail -1; sleep 5; id=$(gh run list --limit 1 --…` -> 21 chars exit=0

### wait / ghx (183 episodes)
- 2026-10-23T19:54 powerhouse-powerhouse (sub) kind=wait_bg calls=4 chars=3081 secs=1337 wakeups=1 prs=[3285] closed_by=notification:completed
    - [wait,bg] `ghx ci wait 3285` -> 308 chars exit=0
    - glue Bash: `f=/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/f4543194-44`
    - glue Bash: `python3 -c "
import json;d=json.load(open('/private/tmp/claude-501/-Users-benjaminjordan-p`
    - glue Bash: `cut -c1-1500 /private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/`
- 2026-10-27T13:44 powerhouse-powerhouse (sub) kind=wait_bg calls=2 chars=2872 secs=1654 wakeups=1 prs=[3306] closed_by=notification:completed
    - [wait,bg] `ghx ci wait 3306` -> 308 chars exit=0
    - glue Bash: `python3 -c "
import json;d=json.load(open('/private/tmp/claude-501/-Users-benjaminjordan-p`
- 2026-10-27T21:50 powerhouse-powerhouse (sub) kind=wait_bg calls=1 chars=718 secs=3273 wakeups=1 prs=[3314] closed_by=notification:completed
    - [wait,bg] `ghx ci wait 3314` -> 308 chars exit=0
- 2026-10-29T14:28 powerhouse-powerhouse kind=wait_bg calls=1 chars=725 secs=1275 wakeups=1 prs=[3333] closed_by=notification:failed
    - [wait,bg] `ghx ci wait 3333 --until mergeable --brief` -> 308 chars exit=0

### status / gh (285 episodes)
- 2026-09-24T15:40 powerhouse-powerhouse kind=contiguous calls=1 chars=2284 secs=4 wakeups=0 prs=[3088] closed_by=tool:Agent
    - [status] `gh pr checks 3088 2>&1 | grep -viE "pending|queued|in_progress|skipping" | head -20; echo "--- failing detail:…` -> 2284 chars exit=0
- 2026-10-09T15:40 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=82 secs=13 wakeups=0 prs=[3197] closed_by=tool:Bash
    - [status] `cd ~/.worktrees/powerhouse/mr-06b-workflow-lease && gh pr view 3197 --json state,mergedAt,mergedBy,mergeCommit…` -> 82 chars exit=0
- 2026-10-21T15:07 powerhouse-recipes (sub) kind=contiguous calls=1 chars=330 secs=1 wakeups=0 prs=[3262] closed_by=tool:Bash
    - [status] `gh pr view 3262 -R powerhouse-inc/powerhouse --json state,mergedAt,title -q '[.state,.mergedAt,.title]|@tsv' 2…` -> 330 chars exit=0
- 2026-10-28T18:40 thegoldenmule-powerhouse-nl kind=contiguous calls=1 chars=277 secs=2 wakeups=0 prs=[] closed_by=tool:Bash
    - [status] `ls .github/ghx.json 2>/dev/null; gh run list --limit 3 2>&1 | head -5` -> 277 chars exit=0

### status / ghx (110 episodes)
- 2026-10-23T18:39 powerhouse-powerhouse kind=contiguous calls=1 chars=2520 secs=8 wakeups=0 prs=[3259] closed_by=tool:Bash
    - [status] `ls .github/ghx.json && ghx pr status 3259` -> 2520 chars exit=0
- 2026-10-27T14:57 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=964 secs=3 wakeups=0 prs=[3298] closed_by=tool:Bash
    - [status] `head -1 /private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/f20946e4-f12f-4fb0-8855-f…` -> 964 chars exit=0
- 2026-10-27T19:31 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=2442 secs=1 wakeups=0 prs=[3313] closed_by=tool:Bash
    - [status] `ghx api repos/powerhouse-inc/powerhouse/pulls/3313 --fields passthrough.json.title,passthrough.json.body` -> 2442 chars exit=0
- 2026-10-29T14:37 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=3789 secs=8 wakeups=0 prs=[3340] closed_by=tool:SubagentHandback
    - [status] `R=/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/3c2fb48f-5ae7-4592-b771-8de6305…` -> 3789 chars exit=0

### merge / gh (45 episodes)
- 2026-09-24T18:28 powerhouse-powerhouse kind=contiguous calls=2 chars=104 secs=22 wakeups=0 prs=[3088] closed_by=tool:Bash
    - [status] `gh pr checks 3088 --json name,state --jq '[.[] | .state] | group_by(.) | map("\(.[0])=\(length)") | join(", ")…` -> 60 chars exit=0
    - [merge] `gh pr merge 3088 --squash --subject "feat(reactor): action signature integrity (#3088)" --body-file /private/t…` -> 44 chars exit=0
- 2026-10-09T17:42 powerhouse-powerhouse kind=contiguous calls=2 chars=103 secs=11 wakeups=0 prs=[3184, 3203] closed_by=prompt
    - [status] `git fetch -q origin && gh pr view 3184 --json mergeCommit,title --jq '"#3184 \(.title[0:50]) merge=\(.mergeCom…` -> 80 chars exit=0
    - [merge] `gh pr merge 3203 --merge 2>&1 | tail -3; gh pr view 3203 --json state,mergeCommit --jq '"#3203 \(.state) \(.me…` -> 23 chars exit=0
- 2026-10-13T20:09 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=52 secs=15 wakeups=0 prs=[3230, 3234] closed_by=tool:Bash
    - [merge,loop] `perl -e 'alarm 120; exec @ARGV' gh pr merge 3230 --merge --match-head-commit 89ce5260a779299893a0fffb9a673f891…` -> 52 chars exit=0
- 2026-10-28T16:41 powerhouse-recipes (sub) kind=contiguous calls=1 chars=68 secs=11 wakeups=0 prs=[19] closed_by=tool:SubagentHandback
    - [merge] `gh pr merge 19 --merge 2>&1 | tail -3; gh pr view 19 --json state,mergedAt,mergeCommit --jq '.state+" "+.merge…` -> 68 chars exit=0

### merge / ghx (29 episodes)
- 2026-10-23T21:09 powerhouse-powerhouse (sub) kind=contiguous calls=6 chars=9372 secs=28 wakeups=0 prs=[3286] closed_by=tool:Write
    - [meta] `cd ~/projects/powerhouse/powerhouse && git log --oneline origin/main -1; git log --oneline -1; git show --stat…` -> 2778 chars exit=0
    - [status] `cd ~/projects/powerhouse/powerhouse && ghx pr status 3286 > /private/tmp/claude-501/-Users-benjaminjordan-proj…` -> 334 chars exit=0
    - [meta] `cd ~/projects/powerhouse/powerhouse && ghx pr merge --help 2>&1 | head -40` -> 2247 chars exit=0
    - [merge] `cd ~/projects/powerhouse/powerhouse && ghx pr merge 3286 --method merge --expect-head 31a02436edeb5753bff9a402…` -> 1929 chars exit=0
    - [merge] `cd ~/projects/powerhouse/powerhouse && ghx pr merge 3286 --method merge --expect-head 31a02436edeb5753bff9a402…` -> 2016 chars exit=0
    - [status] `cd ~/projects/powerhouse/powerhouse && ghx pr status 3286 > /private/tmp/claude-501/-Users-benjaminjordan-proj…` -> 68 chars exit=0
- 2026-10-27T17:30 powerhouse-powerhouse kind=contiguous calls=2 chars=913 secs=13 wakeups=0 prs=[3310] closed_by=tool:SendMessage
    - [status] `ghx pr status 3310 --brief` -> 563 chars exit=0
    - [merge] `ghx pr merge 3310 --brief` -> 350 chars exit=0
- 2026-10-27T20:54 powerhouse-powerhouse kind=contiguous calls=1 chars=350 secs=8 wakeups=0 prs=[3313] closed_by=tool:Bash
    - [merge] `ghx pr merge 3313 --expect-head 7820651 --brief` -> 350 chars exit=0
- 2026-10-29T14:49 powerhouse-powerhouse kind=contiguous calls=1 chars=350 secs=9 wakeups=0 prs=[3333] closed_by=tool:Bash
    - [merge] `ghx pr merge 3333 --expect-head ff831b7d25 --brief` -> 350 chars exit=0

### create / gh (55 episodes)
- 2026-09-24T01:59 powerhouse-powerhouse kind=contiguous calls=1 chars=130 secs=4 wakeups=0 prs=[3088] closed_by=tool:Bash
    - [create] `cd ~/.worktrees/powerhouse/action-signature-integrity && gh pr create --base main --head feat/action-signature…` -> 130 chars exit=0
- 2026-10-08T13:59 powerhouse-powerhouse kind=contiguous calls=1 chars=561 secs=16 wakeups=0 prs=[3195] closed_by=tool:Write
    - [create] `set -e git push -u origin feat/mr-02-dev-worker-fingerprint feat/mr-04-pglite-self-heal feat/mr-06b-workflow-l…` -> 561 chars exit=0
- 2026-10-13T14:27 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=54 secs=4 wakeups=0 prs=[3231] closed_by=tool:Write
    - [create] `gh pr create --base main --head fix/graphql-schema-robustness --title "fix(reactor-api): isolate unusable docu…` -> 54 chars exit=0
- 2026-10-21T17:17 powerhouse-recipes (sub) kind=contiguous calls=1 chars=255 secs=5 wakeups=0 prs=[3268] closed_by=tool:SubagentHandback
    - [create] `W=/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-recipes/5c44e0f6-9f27-4958-be12-49a0b71499…` -> 255 chars exit=0

### create / ghx (37 episodes)
- 2026-10-23T19:54 powerhouse-powerhouse (sub) kind=contiguous calls=3 chars=9575 secs=24 wakeups=0 prs=[3285] closed_by=tool:Bash
    - [create] `ghx pr create --input /private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/f4543194-44…` -> 2225 chars exit=2
    - [create] `cd /private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/f4543194-44d8-4d22-b2f5-01e15b…` -> 4888 chars exit=0
    - [create] `ghx pr create --input /private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/f4543194-44…` -> 2462 chars exit=0
- 2026-10-27T14:26 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=492 secs=4 wakeups=0 prs=[] closed_by=prompt
    - [create] `cd ~/.worktrees/powerhouse/v8-wasm-wrapper-tiering && git status --porcelain | head -3; git log --oneline orig…` -> 492 chars exit=0
- 2026-10-28T16:10 powerhouse-powerhouse (sub) kind=contiguous calls=1 chars=849 secs=5 wakeups=0 prs=[] closed_by=prompt
    - [create] `cd ~/.worktrees/powerhouse/builder-ui && git push -q -u origin feat/builder-ui 2>&1 | tail -3; cd /Users/benja…` -> 849 chars exit=2
- 2026-10-29T14:16 powerhouse-powerhouse (sub) kind=contiguous calls=3 chars=10363 secs=17 wakeups=0 prs=[3340] closed_by=prompt
    - [create] `cd ~/.worktrees/powerhouse/reland-3-gate && ghx pr create --input /private/tmp/claude-501/-Users-benjaminjorda…` -> 6758 chars exit=0
    - [create] `R=/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/3c2fb48f-5ae7-4592-b771-8de6305…` -> 3358 chars exit=0
    - glue Write: `/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/3c2fb48f-5ae7`

### feedback / ghx (1 episodes)
- 2026-10-26T19:25 powerhouse-powerhouse (sub) kind=contiguous calls=2 chars=4025 secs=9 wakeups=0 prs=[3294] closed_by=tool:Bash
    - [status] `ghx pr status 3294` -> 3281 chars exit=0
    - [feedback] `ghx pr feedback 3294` -> 744 chars exit=0

### reply / gh (1 episodes)
- 2026-10-12T13:40 powerhouse-powerhouse (sub) kind=contiguous calls=2 chars=314 secs=5 wakeups=0 prs=[3168] closed_by=eof
    - [reply] `gh pr comment 3168 --body-file /private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/fc…` -> 78 chars exit=0
    - glue Write: `/private/tmp/claude-501/-Users-benjaminjordan-projects-powerhouse-powerhouse/fcf6ac4f-ec10`

### mixed_any / mixed (3 episodes)
- 2026-10-26T17:12 powerhouse-powerhouse kind=contiguous calls=5 chars=4192 secs=2242 wakeups=0 prs=[] closed_by=eof
    - [rerun] `gh run rerun 40345582950 --failed -R powerhouse-inc/powerhouse 2>&1 | tail -2; echo rerun $?` -> 354 chars exit=None
    - [meta] `ghx ci rerun --help; grep -l "workflow_dispatch" .github/workflows/academy*.yml 2>/dev/null; ls .github/workfl…` -> 2097 chars exit=0
    - [status] `ghx run list --commit 2edd19f221 --json databaseId,workflowName,status,conclusion` -> 204 chars exit=0
    - [status] `ghx run list --branch main --limit 6 --json databaseId,workflowName,status,conclusion,headSha` -> 1101 chars exit=0
    - [wait] `for r in 40366507724 40366508087 40366507675 40366507600; do gh run watch $r --exit-status -i 60 -R powerhouse…` -> 436 chars exit=None
- 2026-10-26T20:44 powerhouse-powerhouse (sub) kind=contiguous calls=8 chars=13776 secs=190 wakeups=0 prs=[3295] closed_by=tool:Bash
    - [meta] `ghx ci rerun --help 2>&1 | head -40` -> 2066 chars exit=0
    - [status] `ghx run list --branch feat/monitor-controller --limit 5` -> 1085 chars exit=0
    - [status] `ghx run view 40394851790` -> 4299 chars exit=0
    - [status] `ghx api repos/powerhouse-inc/powerhouse/actions/jobs/121825059450 --jq '.steps[] | [.name,.status,.conclusion,…` -> 1340 chars exit=0
    - [meta] `date -u; cd ~/projects/powerhouse/powerhouse && ghx ci wait --help 2>&1 | python3 -c 'impo…` -> 704 chars exit=0
    - [wait] `for i in $(seq 1 45); do s=$(ghx api repos/powerhouse-inc/powerhouse/actions/jobs/121825059450 --jq .status 2>…` -> 212 chars exit=None
    - … 2 more gh calls
- 2026-10-27T17:39 powerhouse-powerhouse (sub) kind=contiguous calls=2 chars=6274 secs=5 wakeups=0 prs=[3312] closed_by=tool:Bash
    - [other_read] `ls .github/ghx.json 2>/dev/null; gh pr view 3312 --json title,headRefName,baseRefName,files -q '.title, .headR…` -> 304 chars exit=None
    - [status] `ghx pr status 3312` -> 5970 chars exit=0