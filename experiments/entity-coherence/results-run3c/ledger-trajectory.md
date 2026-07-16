# Ledger trajectory — run 3c (C validation), threshold = 0.8 (= 1.0 × person inertia 0.8)

Four rules ON: protected-exclusion, deterministic belief-minting, per-event cap 0.320 (= 0.4 × threshold), ≥ 3 distinct occasions.

Cumulative ledger total per bucket per cycle (and distinct sessions in parens).
A bucket accommodates the cycle it crosses the threshold AND has ≥ 3 distinct occasions (core/belief only).

## Bucket legend

- `rel-7` — [relationship] Priya, closest friend from grad school; 
- `th-16` — [thread] Plans to visit Marcus in Denver before s
- `cs-22` — [current] Marathon training halted; sprained ankle
- `bel-45` — [belief, IDENTITY-BELIEF] 2025-07-19: On her identity and work: 'h
- `cs-59` — [current] [as of 2025-10-04] Snapped at Sam Wednes

## Cumulative total (distinct sessions) by cycle

| cycle | hygiene | `rel-7` | `th-16` | `cs-22` | `bel-45` | `cs-59` | rule events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |  |
| 8 | Y | 0.320 (1) |  |  |  |  |  |
| 9 |  | 0.320 (1) | 0.034 (1) |  |  |  |  |
| 10 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) |  |  |  |
| 11 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) |  |  |  |
| 12 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) |  |  |  |
| 13 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) |  |  | mint:1 |
| 14 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) |  |  |  |
| 15 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.320 (1) |  |  |
| 16 | Y | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.320 (1) |  |  |
| 17 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.320 (1) |  |  |
| 18 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.440 (2) |  |  |
| 19 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.440 (2) |  | mint:1 |
| 20 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.440 (2) | 0.000 (1) |  |
| 21 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.760 (3) | 0.000 (1) | mint:1 |
| 22 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.760 (3) | 0.000 (1) |  |
| 23 |  | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.000 (4) | 0.000 (1) | mint:1 ACCOMMODATED:bel-45 |
| 24 | Y | 0.320 (1) | 0.034 (1) | 0.045 (1) | 0.000 (4) | 0.000 (1) | mint:1 |

Threshold line: **0.8**. Per-event cap: **0.320**. Decoy band (spec): a decoy bucket must stay < 40% of threshold = **0.320** at every cycle AND never reach 3 distinct occasions.

