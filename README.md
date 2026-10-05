# ScaffoldBench

**Does your agent scaffold pay for itself?**

[![CI](https://img.shields.io/github/actions/workflow/status/emiralpayar/scaffoldbench/ci.yml?branch=main&label=CI)](https://github.com/emiralpayar/scaffoldbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/emiralpayar/scaffoldbench)](LICENSE)

ScaffoldBench is an open benchmark of agent-harness architectures built on the Claude Agent SDK.
It runs six scaffolds on the same 25 tasks: plan first, fan out to workers, verify, propose in
parallel, review each action, and a plain single agent as the control. Models, tools, prompts and
budgets are held fixed, so the architecture is the only thing that differs between two rows. Each
comparison is paired, clustered by task, and reported with an interval. A run whose trace does not
show that its architecture ran as designed is excluded from the rankings.

**[Site](https://emiralpayar.github.io/scaffoldbench)** ·
**[Post-mortem](docs/POSTMORTEM.md)** ·
**[Pre-registration](docs/PREREGISTRATION.md)** ·
**[Statistics](docs/STATISTICS.md)** ·
[Architecture](docs/ARCHITECTURE.md)

---

## The story in two acts

**Act 1: the leaderboard said five architectures tied. The traces said four of them never ran.**
The first run set scored five architectures between 0.980 and 1.000 over 90 runs, and we nearly
published it as a null result. The traces showed something else. All 72 planning, decomposition
and selection steps had ended in an error, 35 of 36 executors were handed an empty
`<plan></plan>`, and every second and third parallel proposer started with no tools. The
[post-mortem](docs/POSTMORTEM.md) ([interactive version](https://emiralpayar.github.io/scaffoldbench/postmortem/))
covers the four root causes, why 437 passing tests missed them, and what the harness checks now.
The traces are committed as evidence.

**Act 2: Scaffold or Scale?** Does an agent scaffold pay for itself, and does the answer change as
the model gets stronger? The study is 900 runs: 3 Claude models × 6 architectures × 25 tasks × 2
repeats. Its hypotheses, exclusion rules and analysis were
[pre-registered](docs/PREREGISTRATION.md), and the measurement code was frozen at tag `prereg-v1`
before the first run. Results are pending.

## Results

<!-- RESULTS: filled from scaffold-or-scale-v1 -->

The flagship run set, `scaffold-or-scale-v1`, is in progress and was
[pre-registered](docs/PREREGISTRATION.md) before its first run.

---

## The six architectures

| id | What it does |
| :--- | :--- |
| `single` | One agent with the full toolset. The control that every other row has to beat. |
| `plan-execute` | A tool-less planner writes an ordered plan through a schema, then an executor carries it out with the full toolset. |
| `orchestrator-workers` | An orchestrator splits the task into up to four subtasks, workers run them in parallel in separate contexts, and a synthesis writes the answer. |
| `plan-execute-verify` | Plan and execute, then a read-only verifier checks the real state and returns a verdict through a schema. A blocking rejection goes back for revision, at most twice. |
| `propose-select` | Three read-only proposers investigate in parallel, each from a different angle. A selector picks one and merges the others, and an executor applies it. (Formerly `debate-select`.) |
| `gated-execute` | One executor, but every state-changing tool call goes first to a read-only reviewer that holds the policy and allows or denies it. |

Strategies never import the SDK. Every model call goes through one function, `runQuery`, so trace
capture, cost accounting, the sandbox guard and the budget are identical for every architecture.
Every acting phase gets the same instructions word for word. Details are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The task suite

25 tasks, all registered in [`packages/tasks`](packages/tasks):

| Tier | Tasks | Scored by |
| :--- | :--- | :--- |
| **Base tool-use** | 9: `airline`, `ecommerce` and `support` worlds × easy, medium and hard | Deterministic: assertions over the final world state and the tool journal, with multiplicative penalties for broken rules |
| **Expert tool-use** | 10: long runs against a back office, with records that arrive mid-run. Each has a written hypothesis and documented traps, and its expected outcome comes from an oracle | Deterministic, as above |
| **Research** | 6, over a frozen, licensed corpus of 26 public documents with local BM25 search and no network: 3 rubric-graded, 3 gold-key | The answer (rubric judge, median of 3 samples; or a gold key with no model) and quote-grounded citations |

Hard tasks are adversarial about the *user*, not the model. Some ask for a refund the rules forbid,
or for a ticket to be closed that should be escalated. To add a task, see
[docs/ADDING-A-TASK.md](docs/ADDING-A-TASK.md). The corpus and its licences are described in
[fixtures/README.md](fixtures/README.md).

## Why the numbers can be trusted

- **A fidelity gate.** Every run record carries `integrity: { ok, checks[] }`. The harness checks
  confirm that the guard denied no harness tool, every MCP server connected, no foreign server or
  built-in tool was loaded, every schema call got its reply and no phase fell back on a default.
  Each architecture adds its own checks, for example that every planned worker ran or that the
  verdict was read. A failing run is excluded from rankings and counted on the health page.
  ([integrity.ts](packages/core/src/integrity.ts), [fidelity.ts](packages/strategies/src/fidelity.ts))
- **Deterministic final-state scoring.** Tool-use tasks are graded from the world the agent left
  behind and the journal of its tool calls. No model is involved, and the same trajectory always
  gets the same score. ([defineToolUseTask.ts](packages/tasks/src/defineToolUseTask.ts))
- **Quote-grounded citations.** A research citation counts only if its quote (six or more words)
  appears verbatim in a passage the run was actually shown. Citing a page the agent never opened is
  penalised. ([citations.ts](packages/tasks/src/research/citations.ts))
- **Hermetic sessions.** No settings files, no `.mcp.json`, no claude.ai connectors, no Claude Code
  built-in tools and no host-session variables. A sandbox guard sits on every call, and each of
  these is checked per call. ([hermetic.ts](packages/core/src/hermetic.ts), [guard.ts](packages/core/src/guard.ts))
- **Paired, task-clustered statistics with four-way verdicts.** Contrasts are paired by
  (task, repeat). The bootstrap resamples tasks, with Holm correction per family. A verdict is
  *better*, *worse*, *equivalent* within a stated margin, or *inconclusive*, and none is given on
  fewer than 5 tasks. An `api_error` is never scored as a wrong answer. ([STATISTICS.md](docs/STATISTICS.md))
- **Pre-registration.** Hypotheses, exclusions, analysis and a publication gate were written down
  and tagged before the data existed. ([PREREGISTRATION.md](docs/PREREGISTRATION.md))
- **Tests at the real seam.** Every architecture runs through the real `runQuery`, guard and
  per-call MCP servers against a scripted SDK. A degraded run of each must fail its checks.
  ([realSeam.test.ts](packages/strategies/test/realSeam.test.ts))

## Quickstart

```bash
git clone https://github.com/emiralpayar/scaffoldbench && cd scaffoldbench
npm ci                    # Node 22+
npm run check             # typecheck and the full test suite: no key, no network

npm run bench -- tasks    # the 25 tasks
npm run bench -- doctor   # is this machine ready, and which account would be billed

# the plan and its worst-case cost, for free
npm run bench -- run --strategies single,plan-execute --tasks airline-easy --repeats 1 --dry-run
# the same run, for real
npm run bench -- run --strategies single,plan-execute --tasks airline-easy --repeats 1

npm run bench -- report   # leaderboard, verdicts, health; --markdown writes REPORT.md
npm run dev:web           # the site at http://localhost:3210, traces included
```

> **Running the benchmark costs real money.** It bills an Anthropic API key or a Claude Code login.
> Every run has a ceiling (`--max-cost`, default $1.00, and `--max-seconds`, default 600), and so
> does the whole session (`--total-budget`, default $25). A full matrix is
> models × 6 × 25 × repeats runs, and several architectures make four or more model calls per run.
> Start with `--dry-run`.

`--tasks` accepts ids, worlds, categories and globs (`airline-*`, `research`). The full command
table is in [CONTRIBUTING.md](CONTRIBUTING.md#set-up).

## Repository layout

```
packages/core/        runQuery, sandbox guard, hermetic options, budget, trace, judge,
                      integrity checks, the matrix runner, paired task-clustered analysis
packages/strategies/  the six architectures, the shared phase runner, fidelity checks
packages/tasks/       tool-use worlds (airline, ecommerce, support) with base and expert
                      tasks; research tasks over the frozen corpus with citation audit
apps/cli/             the `scaffoldbench` command: run, report, doctor, tasks, strategies
apps/web/             the static site: leaderboard, matrix, Pareto, health, trace replay,
                      post-mortem
results/              committed run sets: manifest, catalog, one record per run (see results/README.md)
fixtures/             the frozen research corpus, with checksums and licences
docs/                 POSTMORTEM, PREREGISTRATION, STATISTICS, ARCHITECTURE, ADDING-A-TASK
```

## Related work

- Anthropic, [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents)
  (December 2024). The workflow patterns that several architectures here implement.
- Anthropic, [*How we built our multi-agent research system*](https://www.anthropic.com/engineering/multi-agent-research-system)
  (2025). An orchestrator with parallel subagents, applied to research.
- Cognition, [*Don't Build Multi-Agents*](https://cognition.ai/blog/dont-build-multi-agents)
  (2025). The case against parallel subagents.
- Yao et al., [*τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains*](https://arxiv.org/abs/2406.12045)
  (2024). Tool-use tasks scored on final state, in airline and retail domains.
- Kapoor et al., [*AI Agents That Matter*](https://arxiv.org/abs/2407.01502) (2024). Report cost
  with accuracy, and compare against simple baselines.

## Limitations

Results are specific to the models and the moment they were measured. 25 hand-written tasks give
25 clusters, so power is limited by the task count. Prompt wording inside each architecture is a
confound: prompt parity narrows it but does not remove it. Cost is the SDK's reported spend at list
prices. The research rubric judge is a model. The complete list, written before the data existed,
is in [the pre-registration](docs/PREREGISTRATION.md#5-known-limitations-stated-in-advance), and the
statistical limits are in [STATISTICS.md](docs/STATISTICS.md#10-limitations).

## Citation

If you use ScaffoldBench or its results, please cite it using [CITATION.cff](CITATION.cff)
(GitHub's "Cite this repository" button reads it).

## License

[MIT](LICENSE). The documents in `fixtures/corpus` are third-party works under their own licences;
see [fixtures/NOTICE.md](fixtures/NOTICE.md).
