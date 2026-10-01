# Agent Arena — 2026-07-25T20-18-35Z-3fs5

- Run set: 2026-07-25T20-18-35Z-3fs5
- Model: claude-sonnet-5 (effort high)
- Fixtures: replay
- Repeats: 2
- Runs: 90 of 90 completed
- Commit: 164f958bdd33dcb3fd5f38e88a9ae18f3769c7ec
- Spend: $9.1128 on runs, $0.0000 on grading

## Leaderboard

| Strategy | Architecture | n | Mean score (95% CI) | Pass rate | Mean cost | Mean latency | Score per $ |
| :--- | :--- | ---: | :--- | ---: | ---: | ---: | ---: |
| debate-select | Parallel proposals, select, execute | 18 | 1.000 [1.000, 1.000] | 100.0% | $0.1873 | 1m10s | 5.3 |
| single | Single agent | 18 | 0.990 [0.970, 1.000] | 94.4% | $0.0503 | 22.4s | 19.7 |
| plan-execute | Plan then execute | 18 | 0.990 [0.970, 1.000] | 94.4% | $0.0702 | 32.9s | 14.1 |
| plan-execute-verify | Plan, execute, verify, revise | 18 | 0.990 [0.970, 1.000] | 94.4% | $0.1093 | 52.4s | 9.1 |
| orchestrator-workers | Orchestrator with parallel workers | 18 | 0.980 [0.950, 1.000] | 88.9% | $0.0892 | 43.6s | 11.0 |

## Pareto frontier

- `debate-select` — Parallel proposals, select, execute
- `single` — Single agent

## Score by task

| Task | single | plan-execute | orchestrator-workers | plan-execute-verify | debate-select |
| :--- | ---: | ---: | ---: | ---: | ---: |
| airline-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-hard | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-hard | 0.91 | 0.91 | 0.82 | 0.91 | 1.00 |
| support-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| support-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| support-hard | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Cells are the mean score over the repeats of that pair.

## Failure modes

| Strategy | n | none | wrong_answer |
| :--- | ---: | ---: | ---: |
| debate-select | 18 | 18 | 0 |
| plan-execute-verify | 18 | 17 | 1 |
| plan-execute | 18 | 17 | 1 |
| single | 18 | 17 | 1 |
| orchestrator-workers | 18 | 16 | 2 |
| ALL | 90 | 85 | 5 |

## Pairwise verdicts

| Comparison | Mean delta | Verdict |
| :--- | ---: | :--- |
| debate-select vs plan-execute-verify | +0.010 | inconclusive (confidence intervals overlap) |
| debate-select vs plan-execute | +0.010 | inconclusive (confidence intervals overlap) |
| debate-select vs single | +0.010 | inconclusive (confidence intervals overlap) |
| debate-select vs orchestrator-workers | +0.020 | inconclusive (confidence intervals overlap) |
| plan-execute-verify vs plan-execute | +0.000 | inconclusive (confidence intervals overlap) |
| plan-execute-verify vs single | +0.000 | inconclusive (confidence intervals overlap) |
| plan-execute-verify vs orchestrator-workers | +0.010 | inconclusive (confidence intervals overlap) |
| plan-execute vs single | +0.000 | inconclusive (confidence intervals overlap) |
| plan-execute vs orchestrator-workers | +0.010 | inconclusive (confidence intervals overlap) |
| single vs orchestrator-workers | +0.010 | inconclusive (confidence intervals overlap) |
