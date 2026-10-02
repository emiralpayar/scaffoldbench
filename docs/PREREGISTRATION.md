# Pre-registration: Scaffold or Scale?

This document fixes the design, hypotheses and analysis of ScaffoldBench's first flagship run
**before any of its runs exist**. It is committed, and tagged `prereg-v1`, ahead of the first
session of the run set it describes. Anything decided after that point is listed under
[Deviations](#deviations), with the date and the reason, and is never silently folded in.

The question: **does an agent scaffold pay for itself, and does the answer change as the model
underneath gets stronger?** A scaffold here is the orchestration around the model — planning
first, fanning out to workers, verifying, proposing in parallel, reviewing each action — with the
model, tools, task prompt, domain policy and budget held fixed.

## 1. Why pre-register a benchmark

The first run set this repository published (`results/2026-07-25T20-18-35Z-3fs5`) reported that
five architectures tied. Its traces showed that four of them never ran as designed (see the
post-mortem on the site). A null result that came out of a broken harness looked exactly like a
null result about architectures. Writing down what counts as a finding, what is excluded, and how
it is tested — before the data exists — is what keeps the next result from being read into
whatever shape it happens to have.

## 2. Design

| Factor | Levels |
| :--- | :--- |
| Model | `claude-haiku-4-5-20251001`, `claude-sonnet-5-5`, `claude-opus-5-5` |
| Architecture | `single` (control), `plan-execute`, `orchestrator-workers`, `plan-execute-verify`, `propose-select`, `gated-execute` |
| Task | all 25 registered tasks (below) |
| Repeat | 2 per (model, architecture, task) cell |

That is 3 × 6 × 25 × 2 = **900 runs** in one run set, `scaffold-or-scale-v1`.

Two repeats, not three: the tasks are the clusters, so power comes from the task count; Sonnet
5.5's single-agent scores were identical across repeats on 8 of 10 expert tasks in calibration;
and the account's usage limits make every run count (see [Pilot](#3a-pilot)).

**Tasks.** 19 tool-use tasks scored deterministically from the final world state and the tool
journal, and 6 research tasks over a frozen, licensed corpus:

- 9 base tool-use tasks (`airline`, `ecommerce`, `support` × easy, medium, hard).
- 10 expert tool-use tasks: `airline-irrops-reprotect`, `airline-waiver-desk`,
  `airline-cancellation-queue`, `airline-baggage-audit`, `ecommerce-backorder-allocation`,
  `ecommerce-returns-desk`, `ecommerce-inbox-triage`, `support-monday-triage`,
  `support-major-incident`, `support-access-requests`. Each carries a written hypothesis and a
  list of documented traps, both in its source and on its page on the site.
- 3 rubric-graded research tasks (`research-http-redirects`, `research-script-loading`,
  `research-password-hashing`), graded by `claude-sonnet-5-5`, 3 samples reduced by median, at
  the effort each task requests.
- 3 gold-key research tasks graded with no model (`research-status-codes`,
  `research-header-fields`, `research-nist-password-rules`).

**Settings, identical for every cell.** Effort `high` (Haiku 4.5 takes no effort parameter; the
effort each call actually ran at is recorded). Per-run ceilings of $8.00 and 3,600 s, set well
above every calibrated and pilot run so they act as safety nets, not as a treatment. Judge as above.
Concurrency 6. The runner orders cells repeat → task → model → strategy, so an interruption
truncates every arm evenly.

**Sessions.** The account's weekly usage limit cannot cover all 900 runs in one week. The run
set is therefore measured in sessions under one manifest: the Haiku 4.5 cells first (`--defer-models`
holds the other two back), then the Sonnet 5.5 and Opus 5.5 cells after the weekly limit resets
(6 October 2026). The split is by model, decided here, and never by outcome. Any session stopped by the usage limit is resumed with
`--resume`, which runs only missing cells; no cell is ever run again because of its result. Cells
lost to an API error are re-run by the same mechanism.

**Frozen measurement code.** Everything under `packages/` and `scripts/check-wiring.ts` is frozen
at `prereg-v1` for the life of the run set. Later commits may touch the site and the docs only;
`git diff prereg-v1 -- packages` must be empty for every session's recorded commit.

## 3. What is excluded, and what is not

- A run whose `integrity.ok` is false — the harness or the architecture did not run as designed
  (a failed structured-output phase, a parallel phase without its tools, a silent fallback, a
  denied harness tool, an unexpected MCP server, an offered built-in tool) — is excluded from
  every ranking and reported under health. So is a run that ended in `api_error`.
- A run that hit its cost or time ceiling, ran out of turns, or broke a policy is **not**
  excluded: that is the architecture's behaviour, and it is scored as it stands.
- **Publication gate.** The run set is published only if `arena report --strict` passes. If any
  architecture on any model has more than 5% of its runs excluded after re-running API errors,
  that arm is reported as unhealthy and left out of the headline until its cause is understood
  and documented here as a deviation.
- **Ordering rules are system-level.** A rule such as "consult the refund policy before refunding"
  is read from the run's shared tool journal: a lookup by any phase of the architecture satisfies
  it. The benchmark scores the system, not one of its calls. Architectures whose reviewers or
  proposers read the rules before the executor acts get credit for that by design.

## 3a. Pilot

Before this document was committed, one pilot run set (`pilot-1`, kept outside `results/` and
outside the analysis) ran all six architectures on three expert tasks (`airline-waiver-desk`,
`ecommerce-returns-desk`, `support-access-requests`) with Haiku 4.5 and Sonnet 5.5, one repeat
each: 36 runs, $15.93, every run passing its integrity checks. It existed to check the merged
harness end to end and to measure what a run costs against the account's usage limits. It is
disclosed here because the hypotheses below were written while it ran, and its first results were
visible by then.

What it showed, and what it changed:

- On Sonnet 5.5, five architectures scored the same on each task, and `plan-execute-verify`
  scored higher on two of the three. On Haiku 4.5 scores varied widely between architectures.
- `gated-execute` cost about five times `single` on these tasks, and two of its Haiku runs hit the
  then-planned 1,200 s ceiling. A ceiling that binds is a treatment, so the ceilings were raised to
  $8.00 and 3,600 s.
- The cost of a run against the usage limits set the repeats at two and the session split by model.

Nothing else in the design, the hypotheses or the analysis was changed after the pilot.

## 4. Hypotheses

The analysis is `analyzeRunSet` from `packages/core/src/analysis.ts` at `prereg-v1`, with its
defaults: baseline `single`; paired, task-clustered bootstrap (10,000 replicates, seed `0xa11ce`,
Hesterberg's expanded percentile interval); four-way verdicts (better, worse, equivalent,
inconclusive); Holm within each family; equivalence margins of ±0.05 on score and pass rate and
×/÷1.1 on cost and latency; no verdict below 5 tasks. See [STATISTICS.md](STATISTICS.md).

**Primary metric:** score (partial credit, after penalties) over all 25 tasks. Pass rate, cost
and latency are reported alongside.

### Confirmatory (the `baseline` family on score, α = 0.05)

- **H1 — Scaffolds help the small model.** On Haiku 4.5, at least one of `plan-execute-verify`
  and `gated-execute` scores **better** than `single`.
- **H2 — Scaffolds stop paying on the large model.** On Opus 5.5, no architecture scores
  **better** than `single` (each contrast is `equivalent` or `inconclusive`).
- **H3 — Every scaffold costs more.** On every model, every multi-call architecture is **worse**
  than `single` on cost (a cost ratio above 1 with its interval above 1).

H1 and H2 together are the claim "scaffolding matters less as models scale". H2 is a prediction
of no detectable gain, not a proof of none; where the contrast is `equivalent` the report may say
the gain is smaller than 0.05, and where it is `inconclusive` it may not.

### Secondary, pre-specified (each its own Holm family at α = 0.05)

- **H4 — Interaction.** The score gain of `plan-execute-verify` over `single` is **larger** on
  Haiku 4.5 than on Opus 5.5 (the `interaction` family, cheapest vs most capable model).
- **H5 — Scale beats scaffold, one step up.** `single` on Sonnet 5.5 scores **better** than every
  architecture on Haiku 4.5 (the `scale` family, Haiku → Sonnet).
- **H6 — Fan-out buys time, not score, on breadth research.** On the gold-key research tasks,
  `orchestrator-workers` is **equivalent** to `single` on score and **better** on latency.
  Analysed on the research subset; exploratory in power, because three tasks are fewer than the
  five any verdict needs — so H6 is reported descriptively, with that stated.

A conclusion drawn from two families at once carries a familywise error rate of up to 2α, and the
report says so where it does it.

### Task-level predictions (exploratory)

Each expert task's source states which architecture it expects to do best, and why. These are
reported as a hit/miss scorecard per task and model, without multiplicity control, and never
promoted to a headline. They are listed in [Appendix A](#appendix-a-task-level-predictions).

## 5. Known limitations, stated in advance

- **Headroom differs by model.** In single-agent calibration the expert tier averaged 0.48 on
  Haiku 4.5 and 0.83 on Sonnet 5.5, and 0.95 on the five expert tasks Opus 5.5 was tried on. The
  research tasks scored 1.0 with `single` on five of six for Sonnet 5.5. Opus 5.5 therefore has
  little room to show any gain, which is part of what H2 is about and also a limit on it.
- **Calibration used `single` only.** Tasks were tuned against the control, not against the
  architectures, so no architecture was favoured by tuning — and no architecture's failure modes
  were tuned for either.
- **25 hand-written tasks are 25 clusters.** Power is limited by the task count, not the repeats.
  Sonnet 5.5's single-agent scores were identical across repeats on 8 of 10 expert tasks, so a
  repeat adds little information on that model — and with two repeats, pass^k is a weak
  reliability measure (k = 2).
- **Several expert tasks share one lever** — work that arrives mid-run and is seen only by an
  agent that re-reads live state. Their results speak to that behaviour first.
- **Injection and irreversible-action traps** never fired for `single` in calibration. They can
  separate architectures only if an architecture introduces the error; they are reported as
  guards, not discriminators.
- **Cost** is the Agent SDK's reported spend at list prices, and the subscription that pays for
  this run does not bill per call. Ratios between architectures are the quantity of interest.

## Deviations

None yet. Each entry: date, what changed, why, and what it affects.

## Appendix A. Task-level predictions

Verbatim from each task's `hypothesis` at `prereg-v1`.

| Task | Prediction |
| :--- | :--- |
| `airline-irrops-reprotect` | single ≥ propose-select > orchestrator-workers |
| `airline-waiver-desk` | plan-execute-verify > single > plan-execute |
| `airline-cancellation-queue` | gated-execute and propose-select > single on the irreversible traps; plan-execute-verify > single on completeness |
| `airline-baggage-audit` | orchestrator-workers ≈ single on score at lower latency; plan-execute-verify highest |
| `ecommerce-backorder-allocation` | single ≥ propose-select > orchestrator-workers, and plan-execute-verify > plan-execute |
| `ecommerce-returns-desk` | orchestrator-workers ≥ single at lower latency; plan-execute-verify > single on accuracy |
| `ecommerce-inbox-triage` | propose-select and plan-execute ≥ single > orchestrator-workers |
| `support-monday-triage` | plan-execute-verify > single; orchestrator-workers ≈ single on accuracy at lower latency |
| `support-major-incident` | propose-select and gated-execute > single > plan-execute |
| `support-access-requests` | gated-execute and propose-select > single > plan-execute |
| `research-password-hashing` | plan-and-verify architectures lead; parallel workers add little |
| `research-status-codes` | tie on score; orchestrator-workers lower latency, higher cost |
| `research-header-fields` | tie on score; orchestrator-workers lower latency, higher cost |
| `research-nist-password-rules` | single matches or beats fan-out on score and cost |

The full reasoning for each is in the task's source and on its page on the site.
