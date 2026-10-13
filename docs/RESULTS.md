# Results: Scaffold or Scale?

The full write-up of `scaffold-or-scale-v1`, ScaffoldBench's first flagship run set: 900 runs,
3 Claude models × 6 agent architectures × 25 tasks × 2 repeats. The design, hypotheses and
analysis were [pre-registered](PREREGISTRATION.md) and the measurement code was frozen at tag
`prereg-v1` before the first run. Every number on this page comes from `analyzeRunSet` at that
tag, with its defaults, over the committed run records in
[`results/scaffold-or-scale-v1`](../results/scaffold-or-scale-v1). The machine-written report is
[`REPORT.md`](../results/scaffold-or-scale-v1/REPORT.md).

**Contents:** [Summary](#summary) · [Design](#1-design-recap) · [Health](#2-health) ·
[Leaderboards](#3-per-model-leaderboards) · [Against single](#4-every-scaffold-against-single-the-baseline-family) ·
[Scale](#5-scaffold-or-scale-the-scale-family) · [Interaction](#6-architecture--model-the-interaction-family) ·
[Scorecard](#7-pre-registration-scorecard) · [Task-level predictions](#8-task-level-predictions-exploratory) ·
[Limitations](#9-limitations) · [Reproduce](#10-reproduce)

## Summary

**Scale beat scaffold.** No scaffold measurably beat a plain single agent on any of the three
models: all 15 score contrasts against `single` were inconclusive after Holm correction. Every
scaffold cost more on every model, ×1.34 to ×4.77 per run, all 15 separated. One model step
(Haiku 4.5 → Sonnet 5.5) raised the single agent's mean score by +0.129, at $0.116 per run instead of $0.091; the best Haiku scaffold (`propose-select`) gained +0.038 over Haiku `single`, not
significant, at ×4.34 the cost.

The prediction that motivated the study, that scaffolds help small models and stop paying on large
ones (H1 with H4), was **not supported**. On Haiku 4.5, four of the five scaffolds scored below
the single agent on point estimates. Of the six pre-registered hypotheses, H3 (every scaffold
costs more) was supported, H2 (no gain on Opus) was consistent with the data, H5 (scale beats
scaffold one step up) was partly supported, and H1, H4 and H6 were not supported.

![Scaffold or Scale? Score by architecture and model](figures/hero.svg)

## 1. Design recap

| Factor | Levels |
| :--- | :--- |
| Model | `claude-haiku-4-5-20251001`, `claude-sonnet-5-5`, `claude-opus-5-5` |
| Architecture | `single` (control), `plan-execute`, `plan-execute-verify`, `orchestrator-workers`, `propose-select`, `gated-execute` |
| Task | 25: 9 base tool-use, 10 expert tool-use, 3 rubric-graded research, 3 gold-key research |
| Repeat | 2 per (model, architecture, task) cell |

- **Settings, identical for every cell.** Effort `high` (Haiku 4.5 takes no effort parameter and
  ran without one). Per-run ceilings of $8.00 and 3,600 s; no run reached either (the largest was
  $3.93 and 3,164 s, both Haiku `gated-execute` on `airline-irrops-reprotect`). Research rubric
  judge `claude-sonnet-5-5`, effort medium, median of 3 samples. Concurrency 6.
- **Software.** Agent SDK 0.3.287, Claude Code 2.1.287, Node v22.22.0, darwin-arm64.
- **Sessions.** Measured from 2 to 12 October 2026 in 12 sessions under one manifest, resumed after
  usage limits and interruptions with `--resume`, which runs only missing cells. Every session
  recorded commit `fce5807` (the `prereg-v1` tag) with a clean tree.
- **Analysis.** Paired by (task, repeat); task-clustered bootstrap, 10,000 replicates, seed
  `0xa11ce`, Hesterberg's expanded percentile interval; four-way verdicts; Holm within each family;
  equivalence margins ±0.05 on score and pass rate, ×/÷1.1 on cost and latency; no verdict on
  fewer than 5 tasks. See [STATISTICS.md](STATISTICS.md).

**Reading the tables.** Intervals are unadjusted 95% intervals; verdicts use Holm-adjusted p-values
within each family. A contrast can therefore have an interval that just excludes zero and still be
*inconclusive* (Haiku `orchestrator-workers` against `single` is one). An asterisk (\*) marks the
caveat *too few tasks carry the spread to show equivalence*: the difference rests on fewer than 5
tasks' worth of spread, so equivalence was not testable either.

## 2. Health

| Check | Result |
| :--- | :--- |
| Runs recorded | 900 of 900; every arm has 50 of 50 cells |
| Integrity checks passed | 900 of 900 (no run excluded) |
| Runs ended by `api_error` | 0 after retries |
| Denied tool calls | 0 |
| Transient API failures retried | 16 runs; only the last attempt is recorded |
| `report --strict` (publication gate) | passes |
| Spend | $354.44 on runs, $9.19 on grading, $17.75 on discarded attempts: $381.37 |

No arm came near the pre-registered 5% exclusion threshold, so every arm is in the headline.

## 3. Per-model leaderboards

Score is the mean over 50 runs with its 95% task-clustered interval. pass^2 is the share of tasks
passed on both repeats. *Frontier* is the uncertainty-aware Pareto status within the model:
`frontier` means no other architecture is both cheaper and at least as good on point estimates;
`tied` means one is ahead on point estimates but the paired comparison does not separate them.

#### Haiku 4.5

| Architecture | Score (95% CI) | Pass | pass^2 | Cost/run | Mean latency | Frontier |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| `single` | 0.771 [0.673, 0.868] | 24/50 | 0.44 | $0.091 | 1m12s | frontier |
| `plan-execute` | 0.754 [0.634, 0.862] | 23/50 | 0.44 | $0.128 | 1m57s | tied |
| `plan-execute-verify` | 0.723 [0.588, 0.845] | 22/50 | 0.36 | $0.305 | 4m39s | tied |
| `orchestrator-workers` | 0.701 [0.573, 0.824] | 20/50 | 0.32 | $0.171 | 1m55s | tied |
| `propose-select` | 0.809 [0.711, 0.901] | 26/50 | 0.48 | $0.373 | 3m31s | frontier |
| `gated-execute` | 0.677 [0.534, 0.809] | 21/50 | 0.36 | $0.862 | 12m17s | tied |

#### Sonnet 5.5

| Architecture | Score (95% CI) | Pass | pass^2 | Cost/run | Mean latency | Frontier |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| `single` | 0.900 [0.843, 0.947] | 27/50 | 0.48 | $0.116 | 33.0s | frontier |
| `plan-execute` | 0.933 [0.895, 0.966] | 29/50 | 0.52 | $0.146 | 45.8s | frontier |
| `plan-execute-verify` | 0.930 [0.856, 0.985] | 37/50 | 0.68 | $0.278 | 1m24s | tied |
| `orchestrator-workers` | 0.924 [0.883, 0.962] | 29/50 | 0.56 | $0.216 | 55.7s | tied |
| `propose-select` | 0.939 [0.903, 0.972] | 31/50 | 0.60 | $0.437 | 1m14s | frontier |
| `gated-execute` | 0.927 [0.889, 0.963] | 29/50 | 0.56 | $0.495 | 2m34s | tied |

#### Opus 5.5

| Architecture | Score (95% CI) | Pass | pass^2 | Cost/run | Mean latency | Frontier |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| `single` | 0.939 [0.903, 0.974] | 33/50 | 0.64 | $0.252 | 52.6s | frontier |
| `plan-execute` | 0.947 [0.913, 0.977] | 33/50 | 0.56 | $0.336 | 1m19s | frontier |
| `plan-execute-verify` | 0.947 [0.890, 0.986] | 38/50 | 0.72 | $0.561 | 2m02s | frontier |
| `orchestrator-workers` | 0.921 [0.869, 0.961] | 30/50 | 0.52 | $0.459 | 1m26s | tied |
| `propose-select` | 0.958 [0.925, 0.985] | 37/50 | 0.72 | $0.928 | 1m54s | frontier |
| `gated-execute` | 0.956 [0.922, 0.985] | 37/50 | 0.72 | $0.934 | 3m15s | tied |


![Cost against score for all 18 arms](figures/cost-vs-score.svg)

Across all 18 arms, the frontier runs Haiku `single` → Sonnet `single` → Sonnet `plan-execute` →
Opus `single` → Opus `plan-execute` → Opus `plan-execute-verify` → Opus `propose-select`. The only
arm dominated on paired evidence is Haiku `gated-execute`.

## 4. Every scaffold against single (the `baseline` family)

The confirmatory family. Five scaffolds × three models = 15 contrasts per metric, Holm-adjusted
together.

![Each scaffold against the single agent, per model](figures/vs-single.svg)

### Score (primary)

| Model | Architecture | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 | `plan-execute` | −0.017 [−0.143, +0.084] | 1.000 | inconclusive* |
| Haiku 4.5 | `plan-execute-verify` | −0.048 [−0.171, +0.051] | 1.000 | inconclusive* |
| Haiku 4.5 | `orchestrator-workers` | −0.070 [−0.152, −0.001] | 0.959 | inconclusive* |
| Haiku 4.5 | `propose-select` | +0.038 [−0.018, +0.094] | 1.000 | inconclusive |
| Haiku 4.5 | `gated-execute` | −0.094 [−0.215, +0.005] | 1.000 | inconclusive* |
| Sonnet 5.5 | `plan-execute` | +0.034 [0.000, +0.087] | 0.959 | inconclusive* |
| Sonnet 5.5 | `plan-execute-verify` | +0.031 [−0.019, +0.077] | 1.000 | inconclusive* |
| Sonnet 5.5 | `orchestrator-workers` | +0.025 [−0.005, +0.078] | 1.000 | inconclusive* |
| Sonnet 5.5 | `propose-select` | +0.040 [+0.003, +0.095] | 0.897 | inconclusive* |
| Sonnet 5.5 | `gated-execute` | +0.028 [−0.012, +0.083] | 1.000 | inconclusive* |
| Opus 5.5 | `plan-execute` | +0.008 [−0.020, +0.039] | 1.000 | inconclusive* |
| Opus 5.5 | `plan-execute-verify` | +0.008 [−0.042, +0.053] | 1.000 | inconclusive* |
| Opus 5.5 | `orchestrator-workers` | −0.019 [−0.051, +0.006] | 1.000 | inconclusive* |
| Opus 5.5 | `propose-select` | +0.018 [0.000, +0.043] | 1.000 | inconclusive* |
| Opus 5.5 | `gated-execute` | +0.016 [0.000, +0.041] | 1.000 | inconclusive* |

### Pass rate

| Model | Architecture | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 | `plan-execute` | −0.020 [−0.180, +0.140] | 1.000 | inconclusive* |
| Haiku 4.5 | `plan-execute-verify` | −0.040 [−0.160, +0.060] | 1.000 | inconclusive* |
| Haiku 4.5 | `orchestrator-workers` | −0.080 [−0.180, +0.020] | 1.000 | inconclusive |
| Haiku 4.5 | `propose-select` | +0.040 [0.000, +0.100] | 1.000 | inconclusive* |
| Haiku 4.5 | `gated-execute` | −0.060 [−0.180, +0.040] | 1.000 | inconclusive* |
| Sonnet 5.5 | `plan-execute` | +0.040 [−0.040, +0.120] | 1.000 | inconclusive* |
| Sonnet 5.5 | `plan-execute-verify` | +0.200 [+0.040, +0.380] | 0.682 | inconclusive |
| Sonnet 5.5 | `orchestrator-workers` | +0.040 [−0.040, +0.120] | 1.000 | inconclusive* |
| Sonnet 5.5 | `propose-select` | +0.080 [−0.020, +0.200] | 1.000 | inconclusive* |
| Sonnet 5.5 | `gated-execute` | +0.040 [−0.100, +0.180] | 1.000 | inconclusive* |
| Opus 5.5 | `plan-execute` | 0.000 [−0.140, +0.160] | 1.000 | inconclusive |
| Opus 5.5 | `plan-execute-verify` | +0.100 [−0.120, +0.320] | 1.000 | inconclusive |
| Opus 5.5 | `orchestrator-workers` | −0.060 [−0.200, +0.060] | 1.000 | inconclusive* |
| Opus 5.5 | `propose-select` | +0.080 [0.000, +0.200] | 1.000 | inconclusive* |
| Opus 5.5 | `gated-execute` | +0.080 [0.000, +0.200] | 1.000 | inconclusive* |

### Cost (ratio of geometric means, scaffold over single)

| Model | Architecture | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 | `plan-execute` | ×1.53 [1.39, 1.68] | 0.001 | worse |
| Haiku 4.5 | `plan-execute-verify` | ×3.33 [2.89, 3.87] | 0.001 | worse |
| Haiku 4.5 | `orchestrator-workers` | ×1.98 [1.61, 2.48] | 0.001 | worse |
| Haiku 4.5 | `propose-select` | ×4.34 [4.03, 4.70] | 0.001 | worse |
| Haiku 4.5 | `gated-execute` | ×4.77 [2.93, 7.73] | 0.001 | worse |
| Sonnet 5.5 | `plan-execute` | ×1.34 [1.25, 1.45] | 0.001 | worse |
| Sonnet 5.5 | `plan-execute-verify` | ×2.40 [2.21, 2.64] | 0.001 | worse |
| Sonnet 5.5 | `orchestrator-workers` | ×1.80 [1.50, 2.23] | 0.001 | worse |
| Sonnet 5.5 | `propose-select` | ×4.06 [3.79, 4.35] | 0.001 | worse |
| Sonnet 5.5 | `gated-execute` | ×2.64 [1.95, 3.52] | 0.001 | worse |
| Opus 5.5 | `plan-execute` | ×1.44 [1.31, 1.60] | 0.001 | worse |
| Opus 5.5 | `plan-execute-verify` | ×2.35 [2.11, 2.65] | 0.001 | worse |
| Opus 5.5 | `orchestrator-workers` | ×1.84 [1.54, 2.24] | 0.001 | worse |
| Opus 5.5 | `propose-select` | ×4.09 [3.74, 4.48] | 0.001 | worse |
| Opus 5.5 | `gated-execute` | ×2.48 [1.89, 3.22] | 0.001 | worse |

### Latency (ratio, scaffold over single)

| Model | Architecture | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 | `plan-execute` | ×1.85 [1.65, 2.07] | 0.001 | worse |
| Haiku 4.5 | `plan-execute-verify` | ×4.00 [3.45, 4.69] | 0.001 | worse |
| Haiku 4.5 | `orchestrator-workers` | ×1.87 [1.50, 2.33] | 0.001 | worse |
| Haiku 4.5 | `propose-select` | ×3.18 [2.78, 3.61] | 0.001 | worse |
| Haiku 4.5 | `gated-execute` | ×4.89 [3.03, 7.85] | 0.001 | worse |
| Sonnet 5.5 | `plan-execute` | ×1.52 [1.40, 1.66] | 0.001 | worse |
| Sonnet 5.5 | `plan-execute-verify` | ×2.53 [2.38, 2.73] | 0.001 | worse |
| Sonnet 5.5 | `orchestrator-workers` | ×1.85 [1.66, 2.05] | 0.001 | worse |
| Sonnet 5.5 | `propose-select` | ×2.41 [2.23, 2.62] | 0.001 | worse |
| Sonnet 5.5 | `gated-execute` | ×2.85 [2.07, 3.84] | 0.001 | worse |
| Opus 5.5 | `plan-execute` | ×1.62 [1.46, 1.79] | 0.001 | worse |
| Opus 5.5 | `plan-execute-verify` | ×2.44 [2.22, 2.70] | 0.001 | worse |
| Opus 5.5 | `orchestrator-workers` | ×1.81 [1.63, 2.02] | 0.001 | worse |
| Opus 5.5 | `propose-select` | ×2.38 [2.18, 2.61] | 0.001 | worse |
| Opus 5.5 | `gated-execute` | ×2.52 [1.94, 3.22] | 0.001 | worse |


Every scaffold was slower than `single` on every model as well, by ×1.52 to ×4.89. The largest
pass-rate gain, Sonnet `plan-execute-verify` (+0.20, 37/50 against 27/50), did not survive Holm
correction.

## 5. Scaffold or Scale? (the `scale` family)

Every architecture on the smaller model against `single` on the next model up. H5 is the
Haiku → Sonnet half; the Sonnet → Opus half was not the subject of a hypothesis and is exploratory.

### Score

| Smaller model arm | vs single on | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 `propose-select` | Sonnet 5.5 | −0.090 [−0.173, −0.001] | 0.332 | inconclusive |
| Haiku 4.5 `single` | Sonnet 5.5 | −0.129 [−0.210, −0.039] | 0.105 | inconclusive |
| Haiku 4.5 `plan-execute` | Sonnet 5.5 | −0.146 [−0.270, −0.033] | 0.107 | inconclusive* |
| Haiku 4.5 `plan-execute-verify` | Sonnet 5.5 | −0.177 [−0.282, −0.077] | 0.019 | worse |
| Haiku 4.5 `orchestrator-workers` | Sonnet 5.5 | −0.199 [−0.315, −0.076] | 0.026 | worse |
| Haiku 4.5 `gated-execute` | Sonnet 5.5 | −0.222 [−0.361, −0.090] | 0.026 | worse |
| Sonnet 5.5 `propose-select` | Opus 5.5 | 0.000 [−0.026, +0.029] | 1.000 | inconclusive* |
| Sonnet 5.5 `plan-execute` | Opus 5.5 | −0.006 [−0.033, +0.020] | 1.000 | equivalent |
| Sonnet 5.5 `plan-execute-verify` | Opus 5.5 | −0.009 [−0.082, +0.051] | 1.000 | inconclusive* |
| Sonnet 5.5 `gated-execute` | Opus 5.5 | −0.012 [−0.035, +0.008] | 1.000 | inconclusive* |
| Sonnet 5.5 `orchestrator-workers` | Opus 5.5 | −0.015 [−0.037, +0.006] | 0.954 | equivalent |
| Sonnet 5.5 `single` | Opus 5.5 | −0.040 [−0.095, −0.001] | 0.332 | inconclusive* |

### Cost (ratio, smaller-model arm over larger-model single)

| Smaller model arm | vs single on | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 `propose-select` | Sonnet 5.5 | ×3.51 [3.12, 4.01] | 0.001 | worse |
| Haiku 4.5 `single` | Sonnet 5.5 | ×0.81 [0.72, 0.93] | 0.015 | better |
| Haiku 4.5 `plan-execute` | Sonnet 5.5 | ×1.24 [1.09, 1.41] | 0.015 | worse |
| Haiku 4.5 `plan-execute-verify` | Sonnet 5.5 | ×2.69 [2.35, 3.13] | 0.001 | worse |
| Haiku 4.5 `orchestrator-workers` | Sonnet 5.5 | ×1.61 [1.26, 2.05] | 0.006 | worse |
| Haiku 4.5 `gated-execute` | Sonnet 5.5 | ×3.86 [2.47, 6.08] | 0.001 | worse |
| Sonnet 5.5 `propose-select` | Opus 5.5 | ×1.94 [1.76, 2.14] | 0.001 | worse |
| Sonnet 5.5 `plan-execute` | Opus 5.5 | ×0.64 [0.58, 0.71] | 0.001 | better |
| Sonnet 5.5 `plan-execute-verify` | Opus 5.5 | ×1.14 [1.04, 1.28] | 0.029 | worse |
| Sonnet 5.5 `gated-execute` | Opus 5.5 | ×1.26 [0.93, 1.69] | 0.254 | inconclusive |
| Sonnet 5.5 `orchestrator-workers` | Opus 5.5 | ×0.86 [0.71, 1.06] | 0.254 | inconclusive |
| Sonnet 5.5 `single` | Opus 5.5 | ×0.48 [0.45, 0.51] | 0.001 | better |

### Pass rate

| Smaller model arm | vs single on | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 `propose-select` | Sonnet 5.5 | −0.020 [−0.160, +0.100] | 1.000 | inconclusive* |
| Haiku 4.5 `single` | Sonnet 5.5 | −0.060 [−0.180, +0.060] | 1.000 | inconclusive* |
| Haiku 4.5 `plan-execute` | Sonnet 5.5 | −0.080 [−0.240, +0.080] | 1.000 | inconclusive* |
| Haiku 4.5 `plan-execute-verify` | Sonnet 5.5 | −0.100 [−0.240, +0.020] | 1.000 | inconclusive |
| Haiku 4.5 `orchestrator-workers` | Sonnet 5.5 | −0.140 [−0.300, 0.000] | 1.000 | inconclusive |
| Haiku 4.5 `gated-execute` | Sonnet 5.5 | −0.120 [−0.260, 0.000] | 1.000 | inconclusive* |
| Sonnet 5.5 `propose-select` | Opus 5.5 | −0.040 [−0.200, +0.120] | 1.000 | inconclusive* |
| Sonnet 5.5 `plan-execute` | Opus 5.5 | −0.080 [−0.260, +0.080] | 1.000 | inconclusive |
| Sonnet 5.5 `plan-execute-verify` | Opus 5.5 | +0.080 [−0.160, +0.320] | 1.000 | inconclusive |
| Sonnet 5.5 `gated-execute` | Opus 5.5 | −0.080 [−0.220, +0.040] | 1.000 | inconclusive* |
| Sonnet 5.5 `orchestrator-workers` | Opus 5.5 | −0.080 [−0.220, +0.040] | 1.000 | inconclusive* |
| Sonnet 5.5 `single` | Opus 5.5 | −0.120 [−0.280, 0.000] | 1.000 | inconclusive* |

### Latency

| Smaller model arm | vs single on | Estimate (95% CI) | p (Holm) | Verdict |
| :--- | :--- | :--- | ---: | :--- |
| Haiku 4.5 `propose-select` | Sonnet 5.5 | ×6.50 [5.84, 7.24] | 0.001 | worse |
| Haiku 4.5 `single` | Sonnet 5.5 | ×2.04 [1.84, 2.26] | 0.001 | worse |
| Haiku 4.5 `plan-execute` | Sonnet 5.5 | ×3.78 [3.42, 4.19] | 0.001 | worse |
| Haiku 4.5 `plan-execute-verify` | Sonnet 5.5 | ×8.18 [7.28, 9.30] | 0.001 | worse |
| Haiku 4.5 `orchestrator-workers` | Sonnet 5.5 | ×3.83 [3.21, 4.61] | 0.001 | worse |
| Haiku 4.5 `gated-execute` | Sonnet 5.5 | ×10.00 [6.17, 16.13] | 0.001 | worse |
| Sonnet 5.5 `propose-select` | Opus 5.5 | ×1.54 [1.40, 1.71] | 0.001 | worse |
| Sonnet 5.5 `plan-execute` | Opus 5.5 | ×0.98 [0.88, 1.08] | 0.658 | inconclusive |
| Sonnet 5.5 `plan-execute-verify` | Opus 5.5 | ×1.62 [1.51, 1.77] | 0.001 | worse |
| Sonnet 5.5 `gated-execute` | Opus 5.5 | ×1.83 [1.34, 2.45] | 0.002 | worse |
| Sonnet 5.5 `orchestrator-workers` | Opus 5.5 | ×1.18 [1.05, 1.34] | 0.019 | worse |
| Sonnet 5.5 `single` | Opus 5.5 | ×0.64 [0.60, 0.68] | 0.001 | better |


**Exploratory: Sonnet `plan-execute` ≈ Opus `single`.** Sonnet 5.5 with `plan-execute` scored
−0.006 [−0.033, +0.020] against Opus 5.5 `single`, *equivalent* within ±0.05, at ×0.64
[0.58, 0.71] the cost and the same latency (×0.98, inconclusive). Sonnet `orchestrator-workers` is
also equivalent to Opus `single` on score, with no cost difference shown. These rows were not
pre-registered as hypotheses, so read them as leads for the next run set rather than findings.

## 6. Architecture × model (the `interaction` family)

The gain of each scaffold over `single` on Haiku 4.5, minus its gain on Opus 5.5. A positive value
means the scaffold helps the small model more.

### Score

| Architecture | Gain on Haiku − gain on Opus (95% CI) | p (Holm) | Verdict |
| :--- | :--- | ---: | :--- |
| `propose-select` | +0.020 [−0.048, +0.083] | 1.000 | inconclusive |
| `plan-execute` | −0.025 [−0.144, +0.067] | 1.000 | inconclusive* |
| `plan-execute-verify` | −0.056 [−0.181, +0.050] | 1.000 | inconclusive* |
| `orchestrator-workers` | −0.051 [−0.139, +0.027] | 0.916 | inconclusive |
| `gated-execute` | −0.110 [−0.234, −0.005] | 0.295 | inconclusive* |

### Pass rate

| Architecture | Gain on Haiku − gain on Opus (95% CI) | p (Holm) | Verdict |
| :--- | :--- | ---: | :--- |
| `propose-select` | −0.040 [−0.160, +0.060] | 1.000 | inconclusive* |
| `plan-execute` | −0.020 [−0.200, +0.140] | 1.000 | inconclusive |
| `plan-execute-verify` | −0.140 [−0.364, +0.100] | 1.000 | inconclusive |
| `orchestrator-workers` | −0.020 [−0.160, +0.140] | 1.000 | inconclusive |
| `gated-execute` | −0.140 [−0.280, −0.020] | 0.474 | inconclusive |


Four of the five score interactions are negative: if anything, the scaffolds did relatively better
on Opus than on Haiku. None separated.

## 7. Pre-registration scorecard

![Pre-registration scorecard](figures/scorecard.svg)

| | Hypothesis | Family | Result | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **H1** | On Haiku 4.5, `plan-execute-verify` or `gated-execute` scores better than `single`. | baseline (confirmatory) | `plan-execute-verify` −0.048 [−0.171, +0.051]; `gated-execute` −0.094 [−0.215, +0.005]; both inconclusive, both below zero. | **Not supported** |
| **H2** | On Opus 5.5, no architecture scores better than `single`. | baseline (confirmatory) | All 5 inconclusive (from −0.019 to +0.018). None is *equivalent*, so the data do not show the gain to be below 0.05 either. | **Consistent** |
| **H3** | On every model, every multi-call architecture costs more than `single`. | baseline (confirmatory) | 15 of 15 *worse* on cost, ×1.34 to ×4.77, every interval above ×1. | **Supported** |
| **H4** | The gain of `plan-execute-verify` over `single` is larger on Haiku 4.5 than on Opus 5.5. | interaction (secondary) | −0.056 [−0.181, +0.050], inconclusive, and the opposite sign to the prediction. | **Not supported** |
| **H5** | `single` on Sonnet 5.5 scores better than every architecture on Haiku 4.5. | scale (secondary) | 3 of 6 shown *worse* than Sonnet `single`: `plan-execute-verify` −0.177, `orchestrator-workers` −0.199, `gated-execute` −0.222. `propose-select` −0.090, `single` −0.129 and `plan-execute` −0.146 inconclusive after Holm. | **Partial** |
| **H6** | On gold-key research, `orchestrator-workers` is equivalent to `single` on score and better on latency. | descriptive (3 tasks < 5) | Slower than `single` on all three models (median 70.6 s vs 68.9 s on Haiku, 43.6 s vs 27.0 s on Sonnet, 63.6 s vs 33.9 s on Opus); ×1.86 to ×3.08 the mean cost on those tasks; mean score 0.983 vs 1.000, 1.000 vs 1.000, 0.917 vs 0.958. | **Not supported** |

H1 and H2 together were the claim "scaffolding matters less as models scale". The half that would
have made it a finding, H1, failed: scaffolds did not help Haiku 4.5. H2 holding on its own says
only that no gain was detected on Opus 5.5, which is also true of Haiku and Sonnet. The
conclusions that draw on two families at once (H1 with H4, or H3 with H5) carry a familywise error
rate of up to 2α.

## 8. Task-level predictions (exploratory)

Each expert task, and four research tasks, stated before the run which architecture should do best
([Appendix A](PREREGISTRATION.md#appendix-a-task-level-predictions)). These are scored here from
per-task means over the two repeats, with no multiplicity control and no intervals, so they are
exploratory and never a headline.

**How a prediction is scored.** Each is split into clauses. Per-task mean scores (the "Score by
task" tables in [REPORT.md](../results/scaffold-or-scale-v1/REPORT.md)) are compared at three
decimals. `A > B` holds when A's per-task mean score is strictly higher than B's; `A ≥ B` when it is not lower; `A ≈ B` and "tie" when the
difference is within ±0.05 (the pre-registered margin); "faster" and "costlier" compare mean
latency and mean cost on that task. Predictions about a part of the score ("on the irreversible
traps", "on completeness", "on accuracy") are scored on the whole task score, because the task
score is the pre-registered metric. "Plan-and-verify architectures lead" is read as the better of
`plan-execute` and `plan-execute-verify` matching or beating every other architecture; "parallel
workers add little" as `orchestrator-workers` gaining at most +0.05 over `single`; "fan-out" in
`research-nist-password-rules` as `orchestrator-workers`. A task is a *hit* on a model when every
clause holds, a *miss* when none does, and *partial* otherwise. The ✓/✗ marks follow the clause
order. Abbreviations: S `single`, PE `plan-execute`, PEV `plan-execute-verify`, OW
`orchestrator-workers`, PS `propose-select`, GE `gated-execute`.


| Task | Clauses tested | Haiku 4.5 | Sonnet 5.5 | Opus 5.5 |
| :--- | :--- | :---: | :---: | :---: |
| `airline-irrops-reprotect` | S ≥ PS; PS > OW | partial ✗✓ | partial ✓✗ | partial ✓✗ |
| `airline-waiver-desk` | PEV > S; S > PE | partial ✓✗ | partial ✗✓ | miss ✗✗ |
| `airline-cancellation-queue` | GE > S; PS > S; PEV > S | hit ✓✓✓ | partial ✗✗✓ | partial ✗✓✓ |
| `airline-baggage-audit` | OW ≈ S; OW faster; PEV highest | partial ✓✗✗ | partial ✓✗✗ | miss ✗✗✗ |
| `ecommerce-backorder-allocation` | S ≥ PS; PS > OW; PEV > PE | partial ✗✓✗ | partial ✗✗✓ | partial ✓✗✗ |
| `ecommerce-returns-desk` | OW ≥ S; OW faster; PEV > S | partial ✓✗✓ | partial ✓✗✓ | partial ✓✗✓ |
| `ecommerce-inbox-triage` | PS ≥ S; PE ≥ S; S > OW | partial ✓✓✗ | partial ✓✓✗ | partial ✓✓✗ |
| `support-monday-triage` | PEV > S; OW ≈ S; OW faster | partial ✓✓✗ | partial ✓✓✗ | partial ✓✓✗ |
| `support-major-incident` | PS > S; GE > S; S > PE | partial ✓✓✗ | miss ✗✗✗ | miss ✗✗✗ |
| `support-access-requests` | GE > S; PS > S; S > PE | partial ✗✓✓ | miss ✗✗✗ | miss ✗✗✗ |
| `research-password-hashing` | max(PE, PEV) ≥ every other; OW − S ≤ +0.05 | partial ✓✗ | hit ✓✓ | hit ✓✓ |
| `research-status-codes` | all six within 0.05; OW faster; OW costlier | partial ✓✗✓ | partial ✓✗✓ | partial ✗✗✓ |
| `research-header-fields` | all six within 0.05; OW faster; OW costlier | partial ✗✓✓ | partial ✓✗✓ | partial ✗✗✓ |
| `research-nist-password-rules` | S ≥ OW; S no costlier than OW | hit ✓✓ | hit ✓✓ | hit ✓✓ |


| | Haiku 4.5 | Sonnet 5.5 | Opus 5.5 |
| :--- | ---: | ---: | ---: |
| Tasks: hit / partial / miss | 2 / 12 / 0 | 2 / 10 / 2 | 2 / 8 / 4 |
| Clauses that held | 24 of 38 | 19 of 38 | 16 of 38 |

Three patterns stand out, all exploratory:

- **The verifier's predicted gains mostly showed up per task.** `plan-execute-verify > single`
  held in 10 of 12 clauses (`airline-waiver-desk`, `airline-cancellation-queue`,
  `ecommerce-returns-desk`, `support-monday-triage` on three models). Its pooled score was still
  not separated from `single` on any model, because it also lost large amounts on a few tasks
  (Haiku `support-hard` 0.00, Sonnet `airline-baggage-audit` 0.36, Opus `support-major-incident`
  0.46).
- **Fan-out never bought time.** `orchestrator-workers` was faster than `single` in 1 of the 15
  latency clauses (Haiku, `research-header-fields`).
- **"single > plan-execute" mostly failed.** It held in 2 of 9 clauses; `plan-execute` usually
  matched or beat `single` on the tasks where the predictions expected the plan to get in the way.

Predictions with strict inequalities are hard to hit on Sonnet 5.5 and Opus 5.5, where most
architectures scored exactly the same on many tasks (on Opus 5.5, 10 of the 25 tasks scored at
least 0.99 under every architecture; 9 on Sonnet 5.5, 5 on Haiku 4.5).

## 9. Limitations

- **25 tasks are 25 clusters.** Power is set by the task count, not the 900 runs. Most score
  contrasts carry the *too few tasks carry the spread* caveat: a few tasks move a lot and the rest
  tie. Inconclusive is not equivalent. On Opus 5.5 none of the five scaffolds was shown to be
  within ±0.05 of `single`. The upper ends of the intervals allow gains of up to about +0.05 on
  Opus 5.5, +0.10 on Sonnet 5.5 and +0.09 on Haiku 4.5.
- **Headroom differs by model.** Opus 5.5 started at 0.939 with `single`, and 10 tasks were at
  ceiling for every architecture, so it had little room to show a gain. Haiku 4.5 had room, and
  the scaffolds still did not use it.
- **One task set, one moment.** Results are specific to these 25 hand-written tasks, these model
  versions and this SDK. Several expert tasks share one lever (work that arrives mid-run).
- **Prompt wording is a confound.** Every acting phase gets the same instructions word for word,
  which narrows but does not remove it. A better-prompted planner or verifier might do better.
- **Cost** is the Agent SDK's reported spend at list prices. The run was paid by a subscription
  that does not bill per call; ratios are the quantity of interest.
- **The research judge is a model** (three rubric-graded tasks), mitigated by a median of three
  samples.
- **The pre-registration was written by the authors** after a disclosed 36-run pilot
  ([§3a](PREREGISTRATION.md#3a-pilot)). Deviations are listed in the pre-registration.

The limitations written down before the data existed are in
[PREREGISTRATION.md §5](PREREGISTRATION.md#5-known-limitations-stated-in-advance).

## 10. Reproduce

```bash
npm ci
npm run bench -- report scaffold-or-scale-v1 --strict      # the report and the publication gate
npx tsx scripts/analysis-json.ts scaffold-or-scale-v1 out.json   # the full analysis as JSON
npx tsx scripts/figures.ts                                  # redraws docs/figures/*.svg
```

All three read only the committed run records, need no key and no network, and are deterministic.
The traces of all 900 runs are in
[`results/scaffold-or-scale-v1/traces`](../results/scaffold-or-scale-v1/traces) and can be replayed
on the site.
