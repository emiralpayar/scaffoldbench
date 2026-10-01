# Statistics

How ScaffoldBench turns run records into claims, and why each step is the way it is.

The benchmark's job is to say whether one agent architecture beats another, and by how much,
at what cost. Small benchmarks overstate that kind of claim far more often than they miss a real
effect. Every choice below exists to keep a ranking honest: when the data cannot separate two
architectures, the output says so and says why.

Two layers live in [`packages/core`](../packages/core/src):

- **`analyzeRunSet`** ([`analysis.ts`](../packages/core/src/analysis.ts)) is the inference: paired,
  task-clustered contrasts with four-way verdicts, per model, plus the cross-model
  "Scaffold or Scale?" contrasts, an uncertainty-aware Pareto frontier and a health report.
  This is what to cite.
- **`summarizeRuns`** ([`aggregate.ts`](../packages/core/src/aggregate.ts)) is the original
  descriptive summary that the site and CLI were built on. It still works, but its pairwise
  verdicts compare marginal intervals, and they should not be cited ([Legacy API](#legacy-api)).

---

## The short version

| Question | Answer |
| :--- | :--- |
| What is the unit of analysis? | The **task**. Runs of one task are not independent, so every interval resamples tasks. |
| How are strategies compared? | **Paired.** Every strategy runs the same (task, repeat) grid, so contrasts use per-cell differences. |
| Which interval? | A **cluster bootstrap with Hesterberg's expanded percentile interval**: 10,000 replicates, seeded. |
| What can a contrast conclude? | **better**, **worse**, **equivalent** (within a stated margin), or **inconclusive**. |
| Multiplicity? | **Holm** within each family (one metric, one kind of contrast, every model). |
| When is no verdict given? | Fewer than 5 tasks; every task moved by the same amount; or, for equivalence, fewer than 5 tasks on which the arms differed at all. |
| What is left out? | Runs whose `integrity.ok` is false and runs that hit an `api_error`. They are counted under `health`, not ranked. |
| Quality metrics | Score (partial credit) and pass rate, compared as differences. |
| Resource metrics | Cost and latency, compared as geometric-mean ratios. |

---

## 1. What is being estimated

A run set is a grid: **model × strategy × task × repeat**. For one arm (a strategy on a model) and
one metric, write $x_{tr}$ for the value in task $t$, repeat $r$. The arm's estimate is the mean
over tasks of each task's mean:

```math
\bar{x}_t = \frac{1}{|R_t|}\sum_{r \in R_t} x_{tr}, \qquad \hat{\mu} = \frac{1}{T}\sum_{t=1}^{T} \bar{x}_t
```

where $R_t$ are the arm's healthy repeats of task $t$ and $T$ the number of tasks. When every
cell is present this is the plain mean of all runs. When some are missing it still weights every
task equally, so a strategy that lost cells is not averaged over a different task mix.

The population this generalizes to is **tasks like these**, not "these nine tasks re-run forever".
That is why the task, not the run, is resampled. In the first published run set
(`results/2026-07-25T20-18-35Z-3fs5`) the between-task share of variance (one-way ICC by task,
per strategy) was 0.83 to 0.97 for cost and 0.90 to 0.96 for latency. An interval that treats
runs as independent describes the second population and comes out far too narrow.

**Metrics.** Four are analyzed:

| Metric | Per-run value | Compared as |
| :--- | :--- | :--- |
| `score` | `score`, 0 to 1 (weighted partial credit after penalties) | difference |
| `pass` | `passed`, 0 or 1 | difference |
| `cost` | `costUsd` | ratio (geometric mean) |
| `latency` | `latencyMs` | ratio (geometric mean) |

`analyzeRunSet` analyzes whatever records it is given. To report a task category on its own,
filter the records first. Tool-use and research tasks are different claims.

## 2. Strategy summaries

For each arm, `models[i].strategies[j]` (`StrategyAnalysis`) reports the following.

**Score, cost and latency.** $\hat{\mu}$ above, with a cluster-bootstrap interval
([§3.2](#32-the-interval)). When every task has the same value the bootstrap has nothing to
resample. Rather than a zero-width interval:

- for score sitting exactly at 0 or 1, a Wilson interval over the runs stands in. A mean of values
  in [0, 1] is at least the share of exact 1s, which Wilson bounds;
- otherwise no interval is reported (`ci: null`, `ciMethod: 'none'`).

`ciMethod` says which of `bootstrap`, `wilson` or `none` produced the interval.

**Pass rate.** The mean over tasks of each task's pass rate, with a **Wilson score interval**
(Wilson, 1927) on an effective sample size that accounts for clustering:

```math
n_{\text{eff}} = \frac{\hat{p}(1-\hat{p})}{\widehat{\operatorname{Var}}(\hat{p})}, \qquad \widehat{\operatorname{Var}}(\hat{p}) = \frac{s^2_{p_t}}{T}, \qquad T \le n_{\text{eff}} \le N
```

That is the binomial variance divided by the task-clustered one, the design-effect device used
for survey proportions (Kish, 1965; Korn & Graubard, 1998). Since a design effect is at most the
cluster size, $n_{\text{eff}}$ is kept between the task count $T$ and the run count $N$. At 0% or
100% the clustered variance cannot be estimated, so $n_{\text{eff}} = N$. Wilson never collapses:
18 passes in 18 runs gives [0.824, 1], not the [1, 1] a percentile bootstrap reports.

**pass^k.** The probability that $k$ independent attempts at a task all pass, which measures
reliability rather than average ability (Yao et al., 2024, τ-bench). Per task, the unbiased
estimate from $c_t$ passes in $n_t$ attempts is

```math
\widehat{\text{pass}^k_t} = \binom{c_t}{k} \Big/ \binom{n_t}{k}
```

averaged over the tasks with $n_t \ge k$, and reported for every $k$ up to the most repeats any
task has, each with a cluster-bootstrap interval (Wilson over tasks at a 0/1 boundary).

**Cost per solved task.** Mean cost per run divided by pass rate,
$\sum_t \bar{c}_t / \sum_t p_t$, with the ratio bootstrapped over tasks. It replaces score per
dollar, which rewards cheap failure: an agent scoring 0.1 for a tenth of a cent "earns" 100 points
per dollar. It is `null` when nothing passed. Its upper bound is `null` (unbounded) when too many
resamples solve nothing.

**Integrity.** The share of the arm's runs, healthy or not, whose recorded `integrity.ok` is true.
Runs written before integrity was recorded are not counted.

**Cells.** `expected`, `included`, `excluded` and `missing` (task, repeat) cells against the
model's grid, so an arm that ran on fewer cells is visible.

Within a model, strategies are listed by the quality metric (score by default), then by cost.
This is an order, not a ranking. Read the contrasts.

## 3. Paired contrasts

### 3.1 The paired difference

Every arm runs the same (task, repeat) cells, so two arms A and B are compared cell by cell on the
cells both have. With $f$ the identity for score and pass, and $\log$ for cost and latency:

```math
D_t = \frac{1}{|R^{AB}_t|} \sum_{r \in R^{AB}_t} \big[ f(x^A_{tr}) - f(x^B_{tr}) \big], \qquad \hat{\theta} = \frac{1}{T}\sum_t D_t
```

For a ratio metric $e^{\hat{\theta}}$ is the geometric mean of the per-cell ratios, the typical
multiplier on a task. Cells with a non-positive cost or latency cannot be logged and are skipped.
Arms may sit on different models: the pairing is by task and repeat.

Pairing removes the between-task variance, which is most of the variance. In the published run
set every scaffold cost more than `single` in 18 of 18 paired cells. The paired interval for
plan-execute's cost ratio is [1.33, 1.58]. The overlap rule on marginal intervals called the same
comparison inconclusive. Across all ten pairs of strategies it separates six on cost and five on
latency; the paired contrasts, after Holm, separate nine of each.
[`analysisPublished.test.ts`](../packages/core/test/analysisPublished.test.ts) pins these
numbers.

### 3.2 The interval

The task-level differences $D_1 \ldots D_T$ (or task means, for a single arm) are resampled
**with replacement, whole tasks at a time**, $B$ = 10,000 times, from a seeded mulberry32 PRNG.
Each replicate is the mean of the resampled values.

**Why one-stage.** It is tempting to also resample repeats within each resampled task. Under the
model $x_{tr} = \mu + a_t + e_{tr}$, the observed task means already vary by
$\sigma^2_a + \sigma^2_e/r$. That is exactly the variance the one-stage bootstrap reproduces.
Resampling repeats adds about $\sigma^2_e (r-1)/r^2$ more, counting the within-task noise twice
and making the interval too wide. Resampling only the top level is the standard remedy (Davison &
Hinkley, 1997; Field & Welsh, 2007).

**Why the expanded percentile interval, not plain percentile or BCa.** A percentile interval is
too narrow at small $T$. It uses the plug-in standard deviation (divisor $T$) and normal rather
than $t$ quantiles. Hesterberg (2015) corrects both by reading the percentiles at $\alpha'/2$ and
$1 - \alpha'/2$, where

```math
\Phi^{-1}\!\left(1 - \tfrac{\alpha'}{2}\right) = \sqrt{\tfrac{T}{T-1}}\; t_{T-1,\,1-\alpha/2}
```

At $T = 9$ and $\alpha = 0.05$, $\alpha' = 0.0144$. BCa (Efron & Tibshirani, 1993) corrects for
bias and skewness, but not for this narrowness. It also estimates its acceleration from a
jackknife over a handful of tasks, and it degrades on the discrete differences that pass/fail
produces. In simulation at nine tasks, over 2,000 data sets each ([§8](#8-validation)):

| 95% interval | normal differences | paired pass/fail differences |
| :--- | ---: | ---: |
| plain percentile | 0.902 | 0.928 |
| BCa | 0.898 | 0.893 |
| **expanded percentile** | **0.949** | **0.945** |

### 3.3 The tests

Each contrast runs two tests on the same bootstrap distribution, each guarded by a sign-flip
permutation test.

**Difference** ($H_0$: $\theta = 0$, two-sided). Two p-values:

- *Bootstrap*, by inverting the expanded percentile interval, so that $p \le \alpha$ exactly when
  the $1 - \alpha$ interval excludes 0 (up to Monte Carlo resolution). With $q$ the share of
  replicates at or below $\theta_0$ (ties count half),
  $p_{>} = F_{t,T-1}\big(\Phi^{-1}(q)\,/\sqrt{T/(T-1)}\big)$. Deep in a tail, where fewer than 20
  replicates lie beyond $\theta_0$, the replicate count can only say "fewer than 1 in $B$", and
  would floor every p-value near $1/B$. A large Holm family could then never reject. There, the
  tail area comes from a normal fit to the replicates; through the expansion that is the one-sample
  $t$-test. Interval endpoints are always read empirically. With the default 10,000 replicates they
  sit at least 24 replicates in from six tasks up, where a difference verdict first becomes
  possible.
- *Sign-flip*: under $H_0$ each task's difference is as likely to have either sign, so the
  observed sum is compared with the sums under all $2^T$ sign assignments. This is Fisher's
  randomization test for paired data, exact under exchangeability. It is enumerated exactly up to
  16 tasks. Beyond that it uses $B$ random assignments with the +1 correction of Phipson & Smyth
  (2010).

The reported $p$ is the **larger** of the two. Either alone is a valid test, so their maximum is
too. It costs power, and in exchange the bootstrap is held in check where it is weakest: few tasks,
most of them tied. With $k$ tasks that differ at all, the sign-flip $p$ is at least $2/2^k$. So
**no difference verdict is possible with fewer than six differing tasks** at $\alpha = 0.05$.

**Equivalence** ($H_0$: $|\theta| \ge m$), as two one-sided tests (TOST; Schuirmann, 1987; Lakens,
2017). $H_0: \theta \le -m$ is tested against $\theta > -m$, and $H_0: \theta \ge m$ against
$\theta < m$. $p_{\text{eq}}$ is the larger of the two. From the bootstrap alone, unadjusted
$p_{\text{eq}} \le \alpha$ exactly when the $1 - 2\alpha$ expanded percentile interval lies inside
$(-m, m)$: the usual "interval inside the margin" reading of TOST. The reported `ci` is the
$1 - \alpha$ interval, so an `equivalent` contrast may show one that reaches slightly past the
margin. Each one-sided $p$ is the larger of the bootstrap and the shifted sign-flip $p$; like
every guard here, that can only make equivalence harder to reach. The shifted sign-flip tests
assume differences symmetric about $\pm m$. They are a guard, never the only basis. Two more exist
because simulation showed the bootstrap TOST claiming equivalence too readily when a true gap of
exactly the margin arrives as rare, large jumps (8–10% instead of 5% before these guards):

- **Informative tasks.** Equivalence also needs at least `minTasks` tasks on which the two arms
  differed in some repeat. The spread of the difference is learned only from those. From a
  handful of lumpy values the bootstrap understates it. This mirrors what the sign-flip guard
  already demands of a difference verdict.
- **Binary variance floor (pass only).** A run-level difference of two pass/fail outcomes lies in
  $\{-1, 0, 1\}$. If the true mean difference were $\pm m$, its variance would be at least
  $m(1-m)$ (put mass $m$ on 1 and the rest on 0). So
  $\operatorname{Var}(\hat{\theta}) \ge m(1-m)\,\overline{1/r_t}\,/\,T$. The equivalence test must
  also pass a $t$-test whose variance is held at that floor. This stops a run set that happened to
  see almost no failures from being read as proof that failures are rare. The same bound holds for
  interaction differences of pass/fail outcomes, because the two models' runs are independent.

**No verdict at all** when there are fewer than `minTasks` (default 5) tasks (`caveat:
'too-few-tasks'`), or when every task moved by exactly the same amount (`'no-variation'`). In the
second case the bootstrap distribution is a point, which says nothing about spread. Both tests
then get $p = 1$, and the contrast stays in its Holm family, so excluding it cannot help the others.

### 3.4 The verdict

Verdicts follow **conditional equivalence testing** (Campbell & Gustafson, 2018), with Holm's
step-down adjustment (Holm, 1979) applied separately to the difference p-values and the
equivalence p-values of a family:

1. Holm-adjusted $p \le \alpha$: **better** or **worse**, by the sign of $\hat{\theta}$.
2. Otherwise, Holm-adjusted $p_{\text{eq}} \le \alpha$: **equivalent**. No difference was shown,
   and the equivalence test rules out one as large as the margin.
3. Otherwise: **inconclusive**.

"Better" means higher score or pass rate, or **lower** cost or latency. A Holm-adjusted verdict can
be `inconclusive` while the unadjusted 95% interval excludes zero. That is the price of making
several comparisons, and the reason the adjusted p-values are reported next to the raw ones.

**Margins** (`margins`, defaults below) are the smallest differences worth caring about. They must
be fixed in the pre-registration. A margin chosen after seeing the data is not a margin.

| Metric | Default margin |
| :--- | :--- |
| score | ±0.05 (5 points of a 0–1 score) |
| pass | ±0.05 (5 percentage points) |
| cost | within ×/÷ 1.1 |
| latency | within ×/÷ 1.1 |

A ±5-point margin on pass rate is demanding. Even two genuinely identical arms passing 95% of runs
are shown equivalent only 38% of the time with 60 tasks × 3 repeats, and 73% of the time with 100
([§8](#8-validation)).

### 3.5 Families

Holm controls the familywise error rate within a family. Each family is one **kind of contrast**
and one **metric**, pooled across **every model** in the run set:

| `family` | Contrasts | Role |
| :--- | :--- | :--- |
| `baseline` | each strategy vs `single` (configurable), within each model | primary; pre-register this one |
| `pairwise` | every pair of strategies within each model | exploratory |
| `scale` | Scaffold or Scale ([§4](#4-scaffold-or-scale)) | primary for the model study |
| `interaction` | architecture × model ([§4](#4-scaffold-or-scale)) | primary for the model study |
| `frontier` | every pair of arms across all models, on quality and cost | feeds the run-set frontier only |

Contrasts without enough tasks to test are left out of the family size. Which hypotheses are
testable depends on how many tasks ran, not on the outcome.

## 4. Scaffold or Scale?

**Model order.** Models are ordered from cheapest to most capable: `modelOrder` first if given,
then by price tier (Haiku, Sonnet, Opus, Fable, matched by name), then by id.

**`scaffoldOrScale`.** For each model and the next one up, **every** strategy on the smaller model
is contrasted with the baseline on the larger, on all four metrics. A typical row: plan-execute on
Haiku 4.5 against single on Sonnet 5.5, with the score difference and the cost ratio, each with an
interval and a verdict. Single against single gives the pure scale effect as a reference. Every
strategy is reported, rather than "the best architecture on model m", on purpose. Picking the best
from the same data and then testing it overstates it (the winner's curse).

**`interactions`.** Does a scaffold's gain shrink on a stronger model? For a strategy $s$ and
models $m_1, m_2$, per cell:

```math
D_{tr} = \big(x^{s,m_1}_{tr} - x^{\text{base},m_1}_{tr}\big) - \big(x^{s,m_2}_{tr} - x^{\text{base},m_2}_{tr}\big)
```

These differences then go through the same paired machinery, on score and pass. `better` means the
strategy gains more on `models[0]`. By default the pair is the cheapest and the most capable model
(`interactionModels` overrides).

## 5. A Pareto frontier that respects uncertainty

Comparing agents on a quality–cost frontier rather than on accuracy alone follows Kapoor et al.
(2024). On point estimates alone, though, a strategy that went 18/18 "dominates" one that went
17/18 at the same price, and the frontier becomes a picture of one coin flip. Here arm P
dominates arm Q only when P is **significantly better on one axis and at least equivalent on the
other** (verdict `better` or `equivalent`). The quality axis is score by default
(`quality: 'pass'` switches it), and the resource axis is cost per run. Each `FrontierEntry` has
a `status`:

- `frontier`: not dominated, with or without uncertainty.
- `tied`: not dominated given the evidence, though dominated on point estimates alone. It stays on
  the frontier because nothing separates it from the arm that beats it.
- `dominated`: some arm beats it with separated evidence, listed in `dominatedBy`.

Equivalence can dominate in the other direction too. An arm whose score is equivalent within the
margin, but which costs significantly more, is dominated even when its point score is a hair
higher. Within a model the frontier uses that model's `pairwise` verdicts. The run-set `frontier`
spans every (model, strategy) arm and uses the `frontier` family.

## 6. Health

A run does not measure its architecture if the harness degraded it. Examples: a planner phase that
died and handed the executor an empty plan, or proposers whose tool server never connected. An
infrastructure failure is not the agent's fault either. So `analyzeRunSet` **excludes from every
ranking**:

- runs whose `integrity.ok` is `false` (the runner fills `integrity` from harness checks and each
  strategy's fidelity checks), and
- runs whose `failureMode` is in `excludeFailureModes` (default `['api_error']`).

`health` reports how many runs were excluded and why: `byReason`, `byStrategy`, `byModel`,
`byCheck` (the ids of failed integrity checks), `byFailureMode`, and `excludedRuns` with each run's
reasons. It also gives the run set's `integrity` rate, and `duplicates`: healthy runs that repeated
a filled cell, where the later run is kept. `summarizeRuns` applies the same exclusion to its
rankings and counts the excluded runs in `totals.excludedRuns`.

## 7. Power planning

"Inconclusive" is only an answer if the design could have detected the effect.
[`planPower`](../packages/core/src/analysisPower.ts) estimates variance components from each
strategy-versus-baseline contrast in a run set. These are one-way random-effects (ANOVA) estimates
on the paired cell differences:

```math
\operatorname{Var}(\hat{\theta}) = \frac{\sigma^2_{\text{between}} + \sigma^2_{\text{within}}/r}{T}
```

$\sigma^2_{\text{within}}$ is the noise of one paired cell around its task mean.
$\sigma^2_{\text{between}}$ is how much the true effect differs from task to task. From these the
planner reports the power of the design as run, the minimum detectable effect, the repeats needed
at the current task count, and the tasks needed at the current repeat count. Power is approximated
with a shifted central $t$ on $T-1$ degrees of freedom. It is zero when $2/2^T > \alpha$, because
the verdict also needs the sign-flip test. Repeats shrink only the within-task term, so when tasks
disagree the planner returns `null` rather than an absurd repeat count. Pass the Holm family size
as `familySize` to plan at $\alpha/m$, the step every rejection must clear first.

Plans from a saturated run set are flagged (`warning: 'saturated'` when fewer than five tasks
differed at all, `'no-variation'` when none did). A task set that every architecture aces
understates the variance of the next, harder one. Without any repeated task the within-task
variance cannot be separated from the between-task one; that plan carries `'no-repeats'` and no
repeat count.

## 8. Validation

[`analysisSimulation.test.ts`](../packages/core/test/analysisSimulation.test.ts) checks
coverage and error rates on seeded simulations. CI runs a few hundred trials per scenario. The
table below is the same file at 2,000 trials with the default 10,000 replicates (about two
minutes):

```sh
ARENA_SIM_TRIALS=2000 npx vitest run packages/core/test/analysisSimulation.test.ts --testTimeout=1200000
```

| Scenario | Target | Measured |
| :--- | :--- | ---: |
| 95% interval, 9 tasks, normal differences: expanded percentile | 0.95 | 0.949 |
| … plain percentile | 0.95 | 0.902 |
| … BCa | 0.95 | 0.898 |
| 95% interval, 9 tasks × 3, paired pass/fail: expanded percentile | 0.95 | 0.945 |
| … plain percentile | 0.95 | 0.928 |
| … BCa | 0.95 | 0.893 |
| 95% interval, 20 tasks: expanded percentile | 0.95 | 0.944 |
| 95% interval, 9 tasks × 2, task means far apart: task bootstrap | 0.95 | 0.950 |
| … the legacy bootstrap over runs | 0.95 | 0.801 |
| `better`/`worse` when there is no effect, 20 tasks × 3 | ≤ 0.05 | 0.048 |
| `equivalent` when the gap equals the margin, 20 tasks × 3 | ≤ 0.05 | 0.050 |
| … gap arrives as rare pass/fail failures, 60 tasks × 3 | ≤ 0.05 | 0.000 |
| … rare 0.5-point losses, 30 tasks × 3 | ≤ 0.05 | 0.041 |
| … rare 0.25-point losses, 9 tasks × 2 | ≤ 0.05 | 0.000 |
| `equivalent` (±5 points) for identical arms at 95% pass, 60 tasks × 3 | power | 0.376 |
| … 100 tasks × 3 | power | 0.732 |
| `better` for a 10-point effect, 20 tasks × 3 | power | 0.988 |
| Run sets with any false winner: five identical strategies, 9 tasks × 2, paired + Holm | ≤ 0.05 | 0.000 |
| … the legacy overlap rule | ≤ 0.05 | 0.212 |

The intervals and verdicts are also pinned on small hand-computed examples
([`analysisInference.test.ts`](../packages/core/test/analysisInference.test.ts),
[`analysis.test.ts`](../packages/core/test/analysis.test.ts)). The distributions are pinned against
independently checked reference values ([`stats.test.ts`](../packages/core/test/stats.test.ts)).
The re-analysis of the first published run set is pinned in
[`analysisPublished.test.ts`](../packages/core/test/analysisPublished.test.ts).

## 9. API

```ts
import { analyzeRunSet, planPower } from '@arena/core';

const analysis = analyzeRunSet(records, {
  baseline: 'single',          // default
  margins: { pass: 0.05 },     // pre-registered; the rest keep their defaults
  modelOrder: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5'],
});

for (const model of analysis.models) {
  for (const c of model.vsBaseline.filter((c) => c.metric === 'pass')) {
    console.log(model.model, c.a.strategyId, c.estimate, c.ci, c.verdict, c.caveat ?? '');
  }
}

const [plan] = planPower(records, { metric: 'pass', delta: 0.1, familySize: 15 });
console.log(plan?.repeatsNeeded, plan?.tasksNeeded, plan?.minimumDetectableEffect);
```

**`analyzeRunSet(records, options?) → RunSetAnalysis`**

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `baseline` | `'single'` | strategy the `baseline` family compares against |
| `modelOrder` | price tier | models from cheapest to most capable |
| `margins` | see §3.4 | equivalence margins per metric |
| `alpha` | 0.05 | familywise error rate; intervals are 1 − alpha |
| `iterations` | 10,000 | bootstrap replicates (and Monte Carlo sign flips above 16 tasks) |
| `seed` | `0xa11ce` | PRNG seed; same records and seed give identical output |
| `minTasks` | 5 (never below 2) | fewest tasks, and fewest differing tasks for equivalence |
| `quality` | `'score'` | quality axis of the frontier and of the strategy order |
| `excludeFailureModes` | `['api_error']` | failure modes that say nothing about the architecture |
| `interactionModels` | cheapest vs most capable | model pairs for the interaction contrasts |

The result holds `settings` (the options after defaults, for citing), `models[]` (`strategies`,
`vsBaseline`, `pairwise`, `frontier`), `scaffoldOrScale`, `interactions`, `frontier`,
`frontierContrasts` and `health`. A `Contrast` carries `estimate` and `ci` on the scale named by
`scale` (a difference, or a ratio of a over b), `margin`, `tasks`, `cells`, `pValue`, `pAdjusted`,
`pEquivalence`, `pEquivalenceAdjusted`, `verdict` and, where the data decided it, a `caveat`. The
whole result is plain JSON. The planned study's size (3 models × 6 strategies × 70 tasks × 3
repeats) takes about a second, because the resampling draws are shared across contrasts.

**Building blocks**, exported for anyone assembling their own analysis: `pairedTest`,
`resolveVerdicts`, `clusterBootstrap`, `bootstrapMeans`, `expandedAlpha`,
`expandedPercentileInterval`, `bootstrapPValues`, `signFlipTest`, `clusterMeanEstimate`,
`uncertainFrontier`, `estimateVarianceComponents`, `powerOfDesign`, `repeatsForPower`,
`tasksForPower`, `minimumDetectableEffect`, plus the primitives in
[`stats.ts`](../packages/core/src/stats.ts): `wilsonInterval`, `holmAdjust`, `normalCdf`,
`normalQuantile`, `studentTCdf`, `studentTQuantile`.

### Legacy API

`summarizeRuns`, `aggregate`, `bootstrapCI`, `comparisonVerdict` and `paretoFrontier` keep working
for the site and CLI. They are descriptive:

- `bootstrapCI` and `aggregate` resample **runs** as if they were independent. They give a
  zero-width interval for a single run or a constant sample. With tasks of different difficulty,
  their 95% intervals covered 80% of the time in the simulation above.
- `comparisonVerdict` (deprecated) calls a winner when two marginal intervals do not overlap. That
  is unpaired, so real paired effects drown in between-task variance. For equal standard errors it
  implies a two-sided α of about 0.006. Next to a zero-width interval at the ceiling it is
  anti-conservative, and across ten comparisons of five identical strategies it named a false
  winner in 21% of simulated run sets. It now refuses outright when either side has a single run.
- `paretoFrontier` uses point estimates.
- `summarizeRuns` pools every model and task category, and builds its `pairwise` verdicts with
  `comparisonVerdict`. It does exclude unhealthy runs from its rankings, as above.

## 10. Limitations

- **Tasks are the population, and few tasks mean wide intervals.** With 9 tasks and 4 contrasts
  in a family, the smallest attainable Holm-adjusted p-value is $4 \times 2/2^9 = 0.016$. With
  fewer than six tasks that differ, no difference can be declared at all. That is the design
  speaking, not the method. Use `planPower` before a run, not after.
- **The cluster is the task id.** If tasks are generated from a smaller number of templates,
  instances of one template are correlated. The intervals then treat them as more independent than
  they are. A template level of clustering is not implemented.
- **Repeats are paired by index.** Within a task, repeat r of one arm is paired with repeat r of
  the other. That only decides which cells count as complete; the task-level difference is the
  same either way when every cell is present.
- **Small-sample bootstrap.** The expanded percentile interval reaches its nominal coverage for the
  scenarios above, but no bootstrap is exact at 5–10 tasks. Marginal cost intervals can undercover
  when per-task costs are heavily skewed. Paired cost contrasts use log ratios, which are much
  closer to symmetric.
- **Equivalence on few, lumpy differences.** The sign-flip halves of the TOST assume symmetric
  differences. The informative-task rule and the binary floor cover the failure modes the
  simulations found, and the measured rates are in the table. They are guards, not a proof for
  every distribution. Read an `equivalent` verdict together with its interval and its task count.
- **Holm is conservative** when tests are positively correlated, as contrasts sharing a baseline
  are. It never overstates.
- **Cost is notional.** `costUsd` is the SDK's figure. Ratios within one model are robust to the
  SDK's price table; cross-model cost ratios are only as right as that table.
- **No mixed model.** A confirmatory generalized linear mixed model with task and template random
  effects is the standard complement to this analysis. It is not part of this package.

## References

- Campbell, H., & Gustafson, P. (2018). Conditional equivalence testing: An alternative remedy for
  publication bias. *PLoS ONE*, 13(4), e0195145.
- Davison, A. C., & Hinkley, D. V. (1997). *Bootstrap Methods and their Application*. Cambridge
  University Press.
- Efron, B., & Tibshirani, R. J. (1993). *An Introduction to the Bootstrap*. Chapman & Hall.
- Field, C. A., & Welsh, A. H. (2007). Bootstrapping clustered data. *Journal of the Royal
  Statistical Society: Series B*, 69(3), 369–390.
- Hesterberg, T. C. (2015). What teachers should know about the bootstrap: Resampling in the
  undergraduate statistics curriculum. *The American Statistician*, 69(4), 371–386.
- Holm, S. (1979). A simple sequentially rejective multiple test procedure. *Scandinavian Journal
  of Statistics*, 6(2), 65–70.
- Kapoor, S., Stroebl, B., Siegel, Z. S., Nadgir, N., & Narayanan, A. (2024). AI agents that
  matter. arXiv:2407.01502.
- Kish, L. (1965). *Survey Sampling*. Wiley.
- Korn, E. L., & Graubard, B. I. (1998). Confidence intervals for proportions with small expected
  number of positive counts estimated from survey data. *Survey Methodology*, 24(2), 193–201.
- Lakens, D. (2017). Equivalence tests: A practical primer for t tests, correlations, and
  meta-analyses. *Social Psychological and Personality Science*, 8(4), 355–362.
- Phipson, B., & Smyth, G. K. (2010). Permutation p-values should never be zero: Calculating exact
  p-values when permutations are randomly drawn. *Statistical Applications in Genetics and
  Molecular Biology*, 9(1), Article 39.
- Schuirmann, D. J. (1987). A comparison of the two one-sided tests procedure and the power
  approach for assessing the equivalence of average bioavailability. *Journal of Pharmacokinetics
  and Biopharmaceutics*, 15(6), 657–680.
- Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference.
  *Journal of the American Statistical Association*, 22(158), 209–212.
- Yao, S., Shinn, N., Razavi, P., & Narasimhan, K. (2024). τ-bench: A benchmark for
  tool-agent-user interaction in real-world domains. arXiv:2406.12045.
