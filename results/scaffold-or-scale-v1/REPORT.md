# ScaffoldBench report — scaffold-or-scale-v1

- **Models:** claude-haiku-4-5-20251001, claude-sonnet-5-5, claude-opus-5-5 · effort high · 2 repeats · fixtures replay
- **Effort:** high requested; ran at haiku-4-5 none (no effort parameter sent), sonnet-5-5 high, opus-5-5 high
- **Runs:** 900 of 900 recorded · complete
- **Commit:** fce5807b2d94 · clean
- **Software:** Agent SDK 0.3.287 · Claude Code 2.1.287 · Node v22.22.0 · darwin-arm64
- **Judge:** claude-sonnet-5-5 · effort medium · 3 samples per graded run
- **Caps:** $8.00 / 1h00m per run · total $200.00 · concurrency 6
- **Spend:** $354.44 on runs · $9.19 on grading · $17.75 on discarded attempts

## Health

- ✅ Every run passed its integrity checks (900 of 900).
- ✅ No tool call was denied.
- ⚠️ 16 runs needed a retry after a transient API failure; only the last attempt is recorded.

## Leaderboard — claude-haiku-4-5-20251001

| Strategy | Architecture | n | Mean score (95% CI) | Pass | Mean cost | Mean latency | Score per $ |
| :--- | :--- | ---: | :--- | ---: | ---: | ---: | ---: |
| ★ propose-select | Parallel proposals, select, execute | 50 | 0.809 [0.711, 0.901] | 26/50 | $0.373 | 3m31s | 2.2 |
| ★ single | Single agent | 50 | 0.771 [0.673, 0.868] | 24/50 | $0.091 | 1m12s | 8.5 |
| ☆ plan-execute | Plan then execute | 50 | 0.754 [0.634, 0.862] | 23/50 | $0.128 | 1m57s | 5.9 |
| ☆ plan-execute-verify | Plan, execute, verify, revise | 50 | 0.723 [0.588, 0.845] | 22/50 | $0.305 | 4m39s | 2.4 |
| ☆ orchestrator-workers | Orchestrator with parallel workers | 50 | 0.701 [0.573, 0.824] | 20/50 | $0.171 | 1m55s | 4.1 |
| ☆ gated-execute | Execute with action review | 50 | 0.677 [0.534, 0.809] | 21/50 | $0.862 | 12m17s | 0.8 |

★ Pareto frontier: no other strategy scores at least as high for less. ☆ tied: another strategy is ahead on point estimates, but the paired comparison does not separate them.

```text
                        0.5      0.6       0.7      0.8       0.9      1.0
★ propose-select        ┊         ┊         ┊├────────●────────┤         ┊  0.809 [0.711, 0.901]
★ single                ┊         ┊      ├─────────●────────┤  ┊         ┊  0.771 [0.673, 0.868]
☆ plan-execute          ┊         ┊  ├───────────●──────────┤  ┊         ┊  0.754 [0.634, 0.862]
☆ plan-execute-verify   ┊        ├────────────●───────────┤    ┊         ┊  0.723 [0.588, 0.845]
☆ orchestrator-workers  ┊      ├────────────●───────────┤      ┊         ┊  0.701 [0.573, 0.824]
☆ gated-execute         ┊  ├─────────────●────────────┤        ┊         ┊  0.677 [0.534, 0.809]
```

### Against single — claude-haiku-4-5-20251001

| Strategy | Score Δ (95% CI) | Score verdict | Cost × (95% CI) | Cost verdict |
| :--- | :--- | :--- | :--- | :--- |
| propose-select | +0.038 [-0.018, +0.094] | inconclusive | ×4.34 [4.03, 4.70] | costlier |
| plan-execute | -0.017 [-0.143, +0.084] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.53 [1.39, 1.68] | costlier |
| plan-execute-verify | -0.048 [-0.171, +0.051] | inconclusive (too few tasks carry the spread to show equivalence) | ×3.33 [2.89, 3.87] | costlier |
| orchestrator-workers | -0.070 [-0.152, -0.001] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.98 [1.61, 2.48] | costlier |
| gated-execute | -0.094 [-0.215, +0.005] | inconclusive (too few tasks carry the spread to show equivalence) | ×4.77 [2.93, 7.73] | costlier |

Compared by paired score differences and cost ratios per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05 of score or ×/÷1.1 of cost. For cost, better means cheaper.

- too few tasks carry the spread to show equivalence: plan-execute (score), plan-execute-verify (score), orchestrator-workers (score), gated-execute (score).

### Pairwise verdicts — claude-haiku-4-5-20251001

| Comparison | Mean delta (95% CI) | Verdict |
| :--- | ---: | :--- |
| propose-select vs single | +0.038 [-0.018, +0.094] | inconclusive |
| propose-select vs plan-execute | +0.056 [-0.051, +0.182] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs plan-execute-verify | +0.087 [-0.016, +0.214] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs orchestrator-workers | +0.108 [+0.015, +0.208] | inconclusive |
| propose-select vs gated-execute | +0.132 [+0.028, +0.259] | inconclusive (too few tasks carry the spread to show equivalence) |
| single vs plan-execute | +0.017 [-0.084, +0.143] | inconclusive (too few tasks carry the spread to show equivalence) |
| single vs plan-execute-verify | +0.048 [-0.051, +0.171] | inconclusive (too few tasks carry the spread to show equivalence) |
| single vs orchestrator-workers | +0.070 [+0.001, +0.152] | inconclusive (too few tasks carry the spread to show equivalence) |
| single vs gated-execute | +0.094 [-0.005, +0.215] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs plan-execute-verify | +0.031 [-0.085, +0.164] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs orchestrator-workers | +0.053 [-0.076, +0.174] | inconclusive |
| plan-execute vs gated-execute | +0.077 [-0.076, +0.222] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs orchestrator-workers | +0.022 [-0.114, +0.145] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs gated-execute | +0.045 [-0.099, +0.188] | inconclusive (too few tasks carry the spread to show equivalence) |
| orchestrator-workers vs gated-execute | +0.024 [-0.062, +0.125] | inconclusive |

Compared by paired score differences per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05.

### Score by task — claude-haiku-4-5-20251001

| Task | propose-select | single | plan-execute | plan-execute-verify | orchestrator-workers | gated-execute |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| airline-easy | 1.00 | 0.71 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-medium | 1.00 | 1.00 | 0.00 | 0.50 | 0.79 | 1.00 |
| airline-hard | 0.71 | 0.71 | 1.00 | 0.71 | 0.43 | 0.50 |
| airline-irrops-reprotect | 0.75 | 0.69 | 0.70 | 0.33 | 0.62 | 0.26 |
| airline-waiver-desk | 0.73 | 0.66 | 0.69 | 0.79 | 0.00 | 0.31 |
| airline-cancellation-queue | 0.59 | 0.37 | 0.36 | 0.46 | 0.36 | 0.49 |
| airline-baggage-audit | 0.26 | 0.44 | 0.54 | 0.32 | 0.43 | 0.00 |
| ecommerce-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-hard | 1.00 | 1.00 | 1.00 | 1.00 | 0.70 | 0.00 |
| ecommerce-backorder-allocation | 0.50 | 0.35 | 0.48 | 0.17 | 0.43 | 0.44 |
| ecommerce-returns-desk | 0.46 | 0.55 | 0.59 | 0.58 | 0.55 | 0.63 |
| ecommerce-inbox-triage | 0.96 | 0.67 | 1.00 | 0.94 | 0.67 | 0.70 |
| support-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| support-medium | 1.00 | 1.00 | 0.42 | 1.00 | 1.00 | 0.65 |
| support-hard | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 |
| support-monday-triage | 0.55 | 0.41 | 0.64 | 0.77 | 0.40 | 0.59 |
| support-major-incident | 0.56 | 0.49 | 0.58 | 0.54 | 0.28 | 0.57 |
| support-access-requests | 0.87 | 0.55 | 0.46 | 0.33 | 0.18 | 0.18 |
| research-http-redirects | 0.57 | 0.89 | 0.89 | 0.89 | 0.92 | 0.92 |
| research-script-loading | 1.00 | 1.00 | 1.00 | 0.95 | 0.95 | 0.95 |
| research-password-hashing | 0.73 | 0.77 | 0.88 | 0.78 | 0.88 | 0.76 |
| research-status-codes | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| research-header-fields | 1.00 | 1.00 | 0.62 | 1.00 | 0.95 | 1.00 |
| research-nist-password-rules | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Cells are the mean score over the repeats of that pair, ranked runs only.

### Failure modes — claude-haiku-4-5-20251001

| STRATEGY | N | none | wrong_answer | policy_violation |
| :--- | ---: | ---: | ---: | ---: |
| propose-select | 50 | 26 | 23 | 1 |
| single | 50 | 24 | 26 | 0 |
| plan-execute | 50 | 23 | 24 | 3 |
| plan-execute-verify | 50 | 22 | 22 | 6 |
| orchestrator-workers | 50 | 20 | 29 | 1 |
| gated-execute | 50 | 21 | 27 | 2 |
| ALL | 300 | 136 | 151 | 13 |

Every run, ranked or not.

## Leaderboard — claude-sonnet-5-5

| Strategy | Architecture | n | Mean score (95% CI) | Pass | Mean cost | Mean latency | Score per $ |
| :--- | :--- | ---: | :--- | ---: | ---: | ---: | ---: |
| ★ propose-select | Parallel proposals, select, execute | 50 | 0.939 [0.903, 0.972] | 31/50 | $0.437 | 1m14s | 2.2 |
| ★ plan-execute | Plan then execute | 50 | 0.933 [0.895, 0.966] | 29/50 | $0.146 | 45.8s | 6.4 |
| ☆ plan-execute-verify | Plan, execute, verify, revise | 50 | 0.930 [0.856, 0.985] | 37/50 | $0.278 | 1m24s | 3.3 |
| ☆ gated-execute | Execute with action review | 50 | 0.927 [0.889, 0.963] | 29/50 | $0.495 | 2m34s | 1.9 |
| ☆ orchestrator-workers | Orchestrator with parallel workers | 50 | 0.924 [0.883, 0.962] | 29/50 | $0.216 | 55.7s | 4.3 |
| ★ single | Single agent | 50 | 0.900 [0.843, 0.947] | 27/50 | $0.116 | 33.0s | 7.7 |

★ Pareto frontier: no other strategy scores at least as high for less. ☆ tied: another strategy is ahead on point estimates, but the paired comparison does not separate them.

```text
                        0.80      0.85         0.90        0.95       1.00
★ propose-select        ┊           ┊            ├────────●───────┤      ┊  0.939 [0.903, 0.972]
★ plan-execute          ┊           ┊          ├─────────●───────┤       ┊  0.933 [0.895, 0.966]
☆ plan-execute-verify   ┊           ┊ ├─────────────────●────────────┤   ┊  0.930 [0.856, 0.985]
☆ gated-execute         ┊           ┊         ├────────●────────┤        ┊  0.927 [0.889, 0.963]
☆ orchestrator-workers  ┊           ┊       ├─────────●─────────┤        ┊  0.924 [0.883, 0.962]
★ single                ┊          ├────────────●───────────┤┊           ┊  0.900 [0.843, 0.947]
```

### Against single — claude-sonnet-5-5

| Strategy | Score Δ (95% CI) | Score verdict | Cost × (95% CI) | Cost verdict |
| :--- | :--- | :--- | :--- | :--- |
| propose-select | +0.040 [+0.003, +0.095] | inconclusive (too few tasks carry the spread to show equivalence) | ×4.06 [3.79, 4.35] | costlier |
| plan-execute | +0.034 [0.000, +0.087] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.34 [1.25, 1.45] | costlier |
| plan-execute-verify | +0.031 [-0.019, +0.077] | inconclusive (too few tasks carry the spread to show equivalence) | ×2.40 [2.21, 2.64] | costlier |
| gated-execute | +0.028 [-0.012, +0.083] | inconclusive (too few tasks carry the spread to show equivalence) | ×2.64 [1.95, 3.52] | costlier |
| orchestrator-workers | +0.025 [-0.005, +0.078] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.80 [1.50, 2.23] | costlier |

Compared by paired score differences and cost ratios per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05 of score or ×/÷1.1 of cost. For cost, better means cheaper.

- too few tasks carry the spread to show equivalence: propose-select (score), plan-execute (score), plan-execute-verify (score), gated-execute (score), orchestrator-workers (score).

### Pairwise verdicts — claude-sonnet-5-5

| Comparison | Mean delta (95% CI) | Verdict |
| :--- | ---: | :--- |
| propose-select vs plan-execute | +0.006 [-0.022, +0.041] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs plan-execute-verify | +0.009 [-0.059, +0.095] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs gated-execute | +0.012 [-0.012, +0.043] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs orchestrator-workers | +0.015 [-0.003, +0.048] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs single | +0.040 [+0.003, +0.095] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs plan-execute-verify | +0.003 [-0.052, +0.071] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs gated-execute | +0.006 [-0.022, +0.033] | inconclusive |
| plan-execute vs orchestrator-workers | +0.009 [-0.014, +0.030] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs single | +0.034 [0.000, +0.087] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs gated-execute | +0.003 [-0.069, +0.062] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs orchestrator-workers | +0.006 [-0.063, +0.062] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs single | +0.031 [-0.019, +0.077] | inconclusive (too few tasks carry the spread to show equivalence) |
| gated-execute vs orchestrator-workers | +0.003 [-0.011, +0.019] | inconclusive (too few tasks carry the spread to show equivalence) |
| gated-execute vs single | +0.028 [-0.012, +0.083] | inconclusive (too few tasks carry the spread to show equivalence) |
| orchestrator-workers vs single | +0.025 [-0.005, +0.078] | inconclusive (too few tasks carry the spread to show equivalence) |

Compared by paired score differences per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05.

### Score by task — claude-sonnet-5-5

| Task | propose-select | plan-execute | plan-execute-verify | gated-execute | orchestrator-workers | single |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| airline-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-hard | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-irrops-reprotect | 1.00 | 1.00 | 0.88 | 1.00 | 1.00 | 1.00 |
| airline-waiver-desk | 0.82 | 0.77 | 0.82 | 0.82 | 0.82 | 0.82 |
| airline-cancellation-queue | 0.80 | 0.90 | 1.00 | 0.80 | 0.80 | 0.80 |
| airline-baggage-audit | 1.00 | 0.72 | 0.36 | 0.75 | 0.69 | 0.70 |
| ecommerce-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-hard | 1.00 | 1.00 | 1.00 | 0.82 | 0.91 | 1.00 |
| ecommerce-backorder-allocation | 0.87 | 0.87 | 0.97 | 1.00 | 0.87 | 0.78 |
| ecommerce-returns-desk | 0.85 | 0.85 | 1.00 | 0.85 | 0.85 | 0.85 |
| ecommerce-inbox-triage | 0.76 | 0.76 | 1.00 | 0.76 | 0.76 | 0.76 |
| support-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| support-medium | 1.00 | 0.85 | 1.00 | 1.00 | 1.00 | 0.92 |
| support-hard | 1.00 | 1.00 | 0.50 | 1.00 | 1.00 | 0.50 |
| support-monday-triage | 0.80 | 0.88 | 1.00 | 0.83 | 0.80 | 0.80 |
| support-major-incident | 0.82 | 0.94 | 0.91 | 0.82 | 0.82 | 0.82 |
| support-access-requests | 0.91 | 0.96 | 1.00 | 0.91 | 0.91 | 0.91 |
| research-http-redirects | 1.00 | 0.94 | 0.94 | 1.00 | 1.00 | 0.94 |
| research-script-loading | 0.97 | 1.00 | 1.00 | 0.95 | 1.00 | 1.00 |
| research-password-hashing | 0.88 | 0.91 | 0.88 | 0.88 | 0.88 | 0.88 |
| research-status-codes | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| research-header-fields | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| research-nist-password-rules | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Cells are the mean score over the repeats of that pair, ranked runs only.

### Failure modes — claude-sonnet-5-5

| STRATEGY | N | none | wrong_answer | policy_violation | hallucinated_citation |
| :--- | ---: | ---: | ---: | ---: | ---: |
| propose-select | 50 | 31 | 19 | 0 | 0 |
| plan-execute | 50 | 29 | 21 | 0 | 0 |
| plan-execute-verify | 50 | 37 | 11 | 2 | 0 |
| gated-execute | 50 | 29 | 20 | 0 | 1 |
| orchestrator-workers | 50 | 29 | 20 | 0 | 1 |
| single | 50 | 27 | 22 | 1 | 0 |
| ALL | 300 | 182 | 113 | 3 | 2 |

Every run, ranked or not.

## Leaderboard — claude-opus-5-5

| Strategy | Architecture | n | Mean score (95% CI) | Pass | Mean cost | Mean latency | Score per $ |
| :--- | :--- | ---: | :--- | ---: | ---: | ---: | ---: |
| ★ propose-select | Parallel proposals, select, execute | 50 | 0.958 [0.925, 0.985] | 37/50 | $0.928 | 1m54s | 1.0 |
| ☆ gated-execute | Execute with action review | 50 | 0.956 [0.922, 0.985] | 37/50 | $0.934 | 3m15s | 1.0 |
| ★ plan-execute-verify | Plan, execute, verify, revise | 50 | 0.947 [0.890, 0.986] | 38/50 | $0.561 | 2m02s | 1.7 |
| ★ plan-execute | Plan then execute | 50 | 0.947 [0.913, 0.977] | 33/50 | $0.336 | 1m19s | 2.8 |
| ★ single | Single agent | 50 | 0.939 [0.903, 0.974] | 33/50 | $0.252 | 52.6s | 3.7 |
| ☆ orchestrator-workers | Orchestrator with parallel workers | 50 | 0.921 [0.869, 0.961] | 30/50 | $0.459 | 1m26s | 2.0 |

★ Pareto frontier: no other strategy scores at least as high for less. ☆ tied: another strategy is ahead on point estimates, but the paired comparison does not separate them.

```text
                        0.85          0.90             0.95           1.00
★ propose-select        ┊               ┊       ├──────────●────────┤    ┊  0.958 [0.925, 0.985]
☆ gated-execute         ┊               ┊      ├──────────●─────────┤    ┊  0.956 [0.922, 0.985]
★ plan-execute-verify   ┊            ├──────────────────●───────────┤    ┊  0.947 [0.890, 0.986]
★ plan-execute          ┊               ┊    ├──────────●────────┤       ┊  0.947 [0.913, 0.977]
★ single                ┊               ┊├───────────●──────────┤        ┊  0.939 [0.903, 0.974]
☆ orchestrator-workers  ┊     ├────────────────●────────────┤            ┊  0.921 [0.869, 0.961]
```

### Against single — claude-opus-5-5

| Strategy | Score Δ (95% CI) | Score verdict | Cost × (95% CI) | Cost verdict |
| :--- | :--- | :--- | :--- | :--- |
| propose-select | +0.018 [0.000, +0.043] | inconclusive (too few tasks carry the spread to show equivalence) | ×4.09 [3.74, 4.48] | costlier |
| gated-execute | +0.016 [0.000, +0.041] | inconclusive (too few tasks carry the spread to show equivalence) | ×2.48 [1.89, 3.22] | costlier |
| plan-execute-verify | +0.008 [-0.042, +0.053] | inconclusive (too few tasks carry the spread to show equivalence) | ×2.35 [2.11, 2.65] | costlier |
| plan-execute | +0.008 [-0.020, +0.039] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.44 [1.31, 1.60] | costlier |
| orchestrator-workers | -0.019 [-0.051, +0.006] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.84 [1.54, 2.24] | costlier |

Compared by paired score differences and cost ratios per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05 of score or ×/÷1.1 of cost. For cost, better means cheaper.

- too few tasks carry the spread to show equivalence: propose-select (score), gated-execute (score), plan-execute-verify (score), plan-execute (score), orchestrator-workers (score).

### Pairwise verdicts — claude-opus-5-5

| Comparison | Mean delta (95% CI) | Verdict |
| :--- | ---: | :--- |
| propose-select vs gated-execute | +0.002 [-0.006, +0.012] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs plan-execute-verify | +0.010 [-0.036, +0.060] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs plan-execute | +0.011 [-0.027, +0.048] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs single | +0.018 [0.000, +0.043] | inconclusive (too few tasks carry the spread to show equivalence) |
| propose-select vs orchestrator-workers | +0.037 [-0.001, +0.090] | inconclusive (too few tasks carry the spread to show equivalence) |
| gated-execute vs plan-execute-verify | +0.008 [-0.040, +0.060] | inconclusive |
| gated-execute vs plan-execute | +0.009 [-0.027, +0.044] | inconclusive (too few tasks carry the spread to show equivalence) |
| gated-execute vs single | +0.016 [0.000, +0.041] | inconclusive (too few tasks carry the spread to show equivalence) |
| gated-execute vs orchestrator-workers | +0.035 [-0.002, +0.088] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs plan-execute | 0.000 [-0.052, +0.040] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs single | +0.008 [-0.042, +0.053] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute-verify vs orchestrator-workers | +0.026 [-0.028, +0.081] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs single | +0.008 [-0.020, +0.039] | inconclusive (too few tasks carry the spread to show equivalence) |
| plan-execute vs orchestrator-workers | +0.026 [-0.006, +0.066] | inconclusive (too few tasks carry the spread to show equivalence) |
| single vs orchestrator-workers | +0.019 [-0.006, +0.051] | inconclusive (too few tasks carry the spread to show equivalence) |

Compared by paired score differences per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05.

### Score by task — claude-opus-5-5

| Task | propose-select | gated-execute | plan-execute-verify | plan-execute | single | orchestrator-workers |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| airline-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-hard | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-irrops-reprotect | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| airline-waiver-desk | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 |
| airline-cancellation-queue | 0.90 | 0.80 | 1.00 | 0.80 | 0.80 | 0.80 |
| airline-baggage-audit | 1.00 | 1.00 | 0.89 | 0.84 | 0.77 | 0.50 |
| ecommerce-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-medium | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-hard | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-backorder-allocation | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ecommerce-returns-desk | 0.85 | 0.85 | 1.00 | 0.85 | 0.85 | 0.85 |
| ecommerce-inbox-triage | 0.76 | 0.76 | 1.00 | 1.00 | 0.76 | 0.88 |
| support-easy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| support-medium | 1.00 | 1.00 | 1.00 | 0.92 | 1.00 | 1.00 |
| support-hard | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| support-monday-triage | 0.88 | 0.93 | 1.00 | 0.95 | 0.88 | 0.88 |
| support-major-incident | 0.82 | 0.82 | 0.46 | 0.91 | 0.82 | 0.82 |
| support-access-requests | 0.91 | 0.91 | 1.00 | 1.00 | 0.91 | 0.91 |
| research-http-redirects | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.90 |
| research-script-loading | 1.00 | 1.00 | 0.95 | 0.96 | 1.00 | 0.91 |
| research-password-hashing | 1.00 | 1.00 | 0.91 | 1.00 | 1.00 | 1.00 |
| research-status-codes | 1.00 | 1.00 | 1.00 | 0.92 | 1.00 | 0.88 |
| research-header-fields | 1.00 | 1.00 | 0.87 | 0.95 | 1.00 | 1.00 |
| research-nist-password-rules | 1.00 | 1.00 | 0.79 | 0.75 | 0.88 | 0.88 |

Cells are the mean score over the repeats of that pair, ranked runs only.

### Failure modes — claude-opus-5-5

| STRATEGY | N | none | wrong_answer | hallucinated_citation | policy_violation |
| :--- | ---: | ---: | ---: | ---: | ---: |
| propose-select | 50 | 37 | 13 | 0 | 0 |
| gated-execute | 50 | 37 | 13 | 0 | 0 |
| plan-execute-verify | 50 | 38 | 6 | 6 | 0 |
| plan-execute | 50 | 33 | 12 | 5 | 0 |
| single | 50 | 33 | 16 | 1 | 0 |
| orchestrator-workers | 50 | 30 | 16 | 3 | 1 |
| ALL | 300 | 208 | 76 | 15 | 1 |

Every run, ranked or not.

## Scaffold or scale? — claude-haiku-4-5-20251001 against single on claude-sonnet-5-5

| Strategy | Score Δ (95% CI) | Score verdict | Cost × (95% CI) | Cost verdict |
| :--- | :--- | :--- | :--- | :--- |
| propose-select | -0.090 [-0.173, -0.001] | inconclusive | ×3.51 [3.12, 4.01] | costlier |
| single | -0.129 [-0.210, -0.039] | inconclusive | ×0.81 [0.72, 0.93] | cheaper |
| plan-execute | -0.146 [-0.270, -0.033] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.24 [1.09, 1.41] | costlier |
| plan-execute-verify | -0.177 [-0.282, -0.077] | worse | ×2.69 [2.35, 3.13] | costlier |
| orchestrator-workers | -0.199 [-0.315, -0.076] | worse | ×1.61 [1.26, 2.05] | costlier |
| gated-execute | -0.222 [-0.361, -0.090] | worse | ×3.86 [2.47, 6.08] | costlier |

Each strategy on the smaller model against single on the larger one. Compared by paired score differences and cost ratios per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05 of score or ×/÷1.1 of cost. For cost, better means cheaper.

- too few tasks carry the spread to show equivalence: plan-execute (score).

## Scaffold or scale? — claude-sonnet-5-5 against single on claude-opus-5-5

| Strategy | Score Δ (95% CI) | Score verdict | Cost × (95% CI) | Cost verdict |
| :--- | :--- | :--- | :--- | :--- |
| propose-select | 0.000 [-0.026, +0.029] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.94 [1.76, 2.14] | costlier |
| plan-execute | -0.006 [-0.033, +0.020] | equivalent | ×0.64 [0.58, 0.71] | cheaper |
| plan-execute-verify | -0.009 [-0.082, +0.051] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.14 [1.04, 1.28] | costlier |
| gated-execute | -0.012 [-0.035, +0.008] | inconclusive (too few tasks carry the spread to show equivalence) | ×1.26 [0.93, 1.69] | inconclusive |
| orchestrator-workers | -0.015 [-0.037, +0.006] | equivalent | ×0.86 [0.71, 1.06] | inconclusive |
| single | -0.040 [-0.095, -0.001] | inconclusive (too few tasks carry the spread to show equivalence) | ×0.48 [0.45, 0.51] | cheaper |

Each strategy on the smaller model against single on the larger one. Compared by paired score differences and cost ratios per task and repeat, a task-clustered bootstrap (10,000 draws) for 95% intervals, Holm-adjusted verdicts; ≈ means shown to lie within ±0.05 of score or ×/÷1.1 of cost. For cost, better means cheaper.

- too few tasks carry the spread to show equivalence: propose-select (score), plan-execute-verify (score), gated-execute (score), single (score).
