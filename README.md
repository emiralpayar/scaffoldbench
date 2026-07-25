# Agent Arena

Everyone argues about agent architectures. Should the agent plan first, or just act? Does a
verifier pay for itself? Is fanning work out to parallel subagents worth the coordination risk?
The arguments are made from anecdote, and almost nobody publishes a number. Agent Arena is a
benchmark lab for exactly that question: it runs **five agent harness architectures** over the
**same task set**, on the same model, through the same instrumentation, and reports score, cost
and latency with bootstrap confidence intervals. The tasks are held constant so that a difference
in the leaderboard is a difference in the *architecture* — not in the model, the prompt, the
toolset or how carefully somebody measured.

---

## What makes the measurement trustworthy

A benchmark is only worth as much as the things it refuses to let slide. These are the ones this
project enforces in code, not in prose.

**Deterministic final-state scoring, with no LLM in the loop.** Every sandbox task owns a world
object. Its tools mutate that object; the scorer reads it afterwards. Grading is a weighted list
of assertions over the final world plus the tool journal — *"reservation R1042 ends with three
checked bags"*, *"exactly one baggage_fee ledger entry, for exactly the bags beyond the free
allowance"* — multiplied by penalties for rule violations. No model participates. Re-running the
same trajectory produces the same score, forever, and there is nothing to argue about.
([`defineToolUseTask.ts`](packages/tasks/src/defineToolUseTask.ts))

**A sandbox guard that blocks the built-in tools.** A strategy that could shell out, read the
filesystem, or hit the open web would not be solving the task through the sandbox the task
defined, and its score would not be comparable. Every model call runs with an exact allowlist,
`permissionMode: 'dontAsk'`, and a `PreToolUse` hook that denies anything outside that list. The
hook is deliberately redundant with the allowlist: it makes each escape attempt an explicit
`tool_denied` trace event, so the report can tell *"never tried to leave the sandbox"* apart from
*"tried and was stopped"* — a real behavioural difference between architectures.
([`guard.ts`](packages/core/src/guard.ts))

**Hermetic runs.** Every call sets `settingSources: []`, so nothing is inherited from `~/.claude`,
from the repository's own settings, or from whatever plugins the operator happens to have
installed. A result that depended on whose machine produced it would not be a result.

**Record/replay fixtures for the research half.** The research tasks reach the web through two
tools of our own, `search` and `fetch_page`, backed by a content-addressed fixture store. `record`
mode performs real requests and writes them to disk; `replay` mode — the default for CI and for
the weekly benchmark — never touches the network. Two strategies compared on a live web are
compared on two different webs.
([`webTools.ts`](packages/tasks/src/research/webTools.ts), [`fixtureStore.ts`](packages/tasks/src/research/fixtureStore.ts))

**Bootstrap confidence intervals, and an explicit `inconclusive`.** Every aggregate carries a
percentile bootstrap CI computed from a seeded PRNG, so the intervals are reproducible across
report runs. `comparisonVerdict` returns `inconclusive` whenever two intervals overlap. With a
handful of repeats that is usually the honest answer, and the report says so instead of ranking
noise. ([`stats.ts`](packages/core/src/stats.ts))

**Judge cost tracked separately from strategy cost.** Research rubrics are graded by a model. That
grading is billed to `judgeCostUsd` on the run record and never to `costUsd`, because folding
grading spend into a strategy's cost would make an architecture look expensive for reasons that
have nothing to do with it. The judge is also sampled several times and reduced by median, so one
unlucky grading cannot move a headline number.
([`judge.ts`](packages/core/src/judge.ts))

**One choke point to the model.** All five strategies reach the model through a single function,
`runQuery`. Trace capture, cost accounting, the sandbox guard, the hermetic settings, the abort
handling and the budget ceiling are therefore identical for every architecture. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## The five architectures

| id | Name | What it does |
| --- | --- | --- |
| `single` | Single agent | One agent, one context, the full toolset, no separate planning or review step. The control condition every other row has to beat. |
| `plan-execute` | Plan then execute | A tool-less planning call writes an ordered list of steps; a second call executes them with the full toolset. |
| `orchestrator-workers` | Orchestrator with parallel workers | An orchestrator splits the task into up to four independent subtasks, runs them concurrently in separate contexts, then synthesizes the answer from their reports. |
| `plan-execute-verify` | Plan, execute, verify, revise | Plan and execute, then a verifier holding only the read-only tools checks the real state rather than the executor's account of it; anything it rejects goes back for revision, at most twice. |
| `debate-select` | Parallel proposals, select, execute | Three proposers investigate in parallel with read-only tools, a selector picks the strongest and merges in what the others got right, and a final call applies it with the full toolset. |

Strategies are pure orchestration: they never import the SDK, they take `runQuery` as an injected
dependency, and every phase builds on the same base system prompt rather than replacing it. Phase
budgets are applied identically — a tool-less phase gets exactly one turn in every architecture —
so no design is quietly handed more room than another.

---

## The task set

### Tool-use tasks — scored deterministically

Three hand-built sandbox worlds, each with an easy, a medium and a hard task. Each world is a
plain in-memory object with integer-cent money and fixed dates, seeded identically for every
repeat.

| World | Tasks |
| --- | --- |
| `airline` | Add checked bags and collect the right fee · Rebook onto the earliest available flight and settle the difference · Cancel a fare the customer wrongly believes is refundable to their card |
| `ecommerce` | Redirect the order that has not shipped · Cancel one line of a multi-line order · Return an expired, partially shipped order |
| `support` | Triage a new service desk ticket · Consolidate duplicate CRM reports · Escalate a payroll outage the requester wants closed |

Each task carries a binding domain policy that is injected into the system prompt for every
strategy, and is scored as:

```
score = (weighted assertions over the final world) x (product of penalty multipliers)
```

Penalties multiply rather than subtract, so a hard rule (`multiplier: 0`) cannot be offset by
scoring well elsewhere — an agent that issues a refund without first reading the refund policy has
failed the task regardless of what else it got right. Ordering rules ("consult before acting") are
read off the tool journal, because "was the rule looked up" leaves no trace in the final state.
The pass threshold is effectively 1.0: partial credit shows up in the mean score, not in the pass
rate.

The hard tasks are deliberately adversarial about the *user*, not the model: `airline-hard` asks
for a cash refund the fare rules do not permit, and `support-hard` asks to close a ticket that
should be escalated. The correct behaviour is to refuse and explain.

### Research tasks — scored by rubric plus citation integrity

Three questions whose correct answers do not drift (HTTP 301 vs 308; `async` vs `defer` on
`<script>`; OWASP vs NIST on password hashing). The last is a deliberate source-disagreement task:
the two authorities give different answers, and the rubric rewards naming and explaining the
conflict rather than silently picking one.

Scoring has two halves:

1. **Rubric (model-graded).** Every rubric item is a pre-declared, checkable statement. A tool-less
   structured-output judge marks each `met` / `partial` / `missing` over several independent
   samples, reduced by median. A source-coverage item, worth 20% of the rubric weight, checks that
   the expected domains were actually opened.
2. **Citation integrity (deterministic, no model).** Because every retrieval went through our own
   `fetch_page` tool, the trace and the tool journal say exactly which URLs the agent opened. Any
   URL cited in the final answer that is not in that set is a fabrication. The audit applies a
   penalty multiplier of `0.5 + 0.5 x integrity`, so a half-fabricated bibliography costs a quarter
   of the score, and the run record keeps the offending URLs.

This is the single most common research-agent failure — a plausible citation to a page the agent
never opened — and catching it requires no judgement call at all.

---

## Quickstart

```bash
git clone <this repo> && cd agent-arena
npm install            # Node 22+
cp .env.example .env   # then put a real key in ANTHROPIC_API_KEY
```

List what is available:

```bash
npm run arena -- tasks        # every task: id, world, category, difficulty
npm run arena -- strategies   # the five architectures and what each one does
npm run arena -- --help
```

A cheap first run — two architectures, one task, one repeat, on the fast model:

```bash
npm run arena -- run \
  --strategies single,plan-execute \
  --tasks airline-easy \
  --repeats 1 \
  --model claude-sonnet-5
```

`--tasks` accepts ids, whole worlds, categories and globs — `--tasks airline-*`, `--tasks research`,
`--tasks support,ecommerce-hard` — so you rarely have to type twelve ids.

Then aggregate and read it:

```bash
npm run arena -- report             # leaderboard, per-cell matrix, pairwise verdicts, Pareto frontier
npm run arena -- report --markdown  # the same, also written to results/<runSetId>/REPORT.md
npm run arena -- report <runSetId>  # any stored run set; defaults to results/latest.json
```

And browse it, including per-run traces:

```bash
npm run dev:web   # http://localhost:3210
```

Other useful commands:

```bash
npm run check         # typecheck + the full test suite
npm run check:wiring  # canary: starts a real SDK session and asserts the MCP tools register
npm run demo:data     # fabricate a run set so the site can be developed without spending anything
```

`npm run demo:data` writes `results/demo-synthetic` with `synthetic: true` in its manifest, and
the site renders an unmissable banner because of it. Those numbers are invented and exist only so
the interface can be reviewed. They are not results.

---

## Cost control

A full matrix is five strategies x twelve tasks x N repeats, and several of the architectures make
four or more model calls per run. Left unchecked that gets expensive quickly, so there are four
brakes:

- **Per-run ceiling** — `--max-cost` (default $1.00, or `ARENA_MAX_COST_USD`) and `--max-seconds`
  (default 600). `BudgetTracker` enforces both across every model call a single run makes, and
  feeds the remaining budget into each subsequent call as `maxBudgetUsd` so the SDK's own limit
  agrees with ours. A run that trips it is recorded with `failureMode: 'budget_exceeded'` rather
  than silently discarded.
- **Total budget** — `--total-budget` (default $25) caps the whole matrix. Once reached, remaining
  cells are skipped and the manifest records `Stopped early: total budget reached.` You get a
  partial run set, not a surprise bill.
- **Replay mode** — `--replay` (the default) serves every research retrieval from committed
  fixtures. Free, offline, and identical between runs. Record once with `--record`, commit the
  fixtures, then replay forever. `--live` fetches without persisting, for checking whether a page
  has moved.
- **Model choice** — sweep and iterate with `--model claude-sonnet-5`; publish headline numbers
  with `claude-opus-5` (the default). Results are model-specific either way (see Limitations), so a
  sonnet sweep tells you which comparisons are worth paying opus to settle — not what the opus
  answer is.

Grading is billed separately and kept cheap on purpose: `--judge-model` defaults to
`claude-sonnet-5` even when the model under test is opus, and `--judge-samples` (default 3) is the
number of independent gradings reduced by median. Use `--no-persist` to score a matrix without
writing anything to `results/`.

---

## Results

_No numbers are published here yet._ This table is filled in from a real run set by
`arena report --markdown`, which writes `results/<runSetId>/REPORT.md`; the weekly benchmark
workflow appends the same report to its job summary and commits the run set. Until a benchmark has
actually been run against a given model, every cell stays empty — publishing invented or
extrapolated numbers would defeat the entire point of the project.

| Strategy | Mean score (95% CI) | Pass rate | Mean cost | Mean latency | Score per $ |
| --- | --- | --- | --- | --- | --- |
| `single` | — | — | — | — | — |
| `plan-execute` | — | — | — | — | — |
| `orchestrator-workers` | — | — | — | — | — |
| `plan-execute-verify` | — | — | — | — | — |
| `debate-select` | — | — | — | — | — |

The report also emits the per-cell matrix, the failure-mode breakdown, the pairwise verdicts
(including every `inconclusive` one) and the score/cost Pareto frontier.

---

## Repository layout

```
packages/core/        contracts, runQuery, budget, trace, sandbox guard, judge,
                      scoring, bootstrap statistics, the matrix runner, aggregation
packages/strategies/  the five harness architectures, plus the shared phase runner
packages/tasks/       the task factories and the task set:
                        defineToolUseTask.ts   deterministic sandbox tasks
                        worlds/{airline,ecommerce,support}/  world, tools, tasks
                        research/              web tools, fixture store, research tasks
apps/cli/             the `arena` command (run · report · tasks · strategies)
apps/web/             Next.js site rendering a stored run set — leaderboard, per-cell
                      matrix, score/cost frontier, run detail and traces
results/              run sets — manifest, catalog, one RunRecord per cell, traces
fixtures/             recorded web responses for replay mode (created by a record run)
scripts/              demo data generator, MCP wiring canary
docs/                 ARCHITECTURE.md, ADDING-A-TASK.md
```

`results/runs/` and the manifests are committed, so a result is reviewable in a diff and citable by
commit sha. Traces are gitignored by default because they are large; commit one deliberately when
it illustrates something worth pointing at.

---

## Limitations

This is an honest list. Read it before quoting anything from this repository.

- **Results are model-specific and a snapshot in time.** Everything here measures *this
  architecture on this model at this moment*. A harness that wins on one model can lose on another
  — much of what a planning phase buys is compensation for weaknesses a stronger model may not
  have. Model updates invalidate a run set. Every manifest records the model, the effort level and
  the git sha for exactly this reason.
- **A handful of repeats gives wide intervals.** Agent runs are high-variance. With three repeats
  per cell most pairwise comparisons come back `inconclusive`, and that is the correct answer
  rather than a bug in the reporting. Do not read a rank ordering off overlapping intervals. If you
  need to separate two architectures, spend the money on more repeats, not on a nicer chart.
- **The research judge is a model, and therefore not perfectly stable.** Two gradings of the same
  answer can disagree. Sampling and taking the median reduces that, and the rubric items are
  written as flat checkable statements rather than quality judgements, but it does not eliminate
  it. This is precisely why the other half of the research score — citation integrity — is fully
  deterministic, and why the tool-use half of the benchmark has no model in the loop at all.
- **The sandbox worlds are hand-built and cannot represent every domain.** Three worlds, nine
  tasks, written by one person. They are designed to require multi-hop lookups, ordering
  discipline, and occasionally refusing the user — but they are not a random sample of real agent
  work, they contain no genuinely ambiguous requirements, and their tools always behave. A harness
  that wins here has won on these twelve tasks.
- **Prompt wording inside each strategy is a confound.** Every architecture needs phase-specific
  instructions, and the wording of those instructions affects the score. The mitigation is to keep
  the phases symmetric: all five build on the identical base system prompt, quote the user's
  request verbatim rather than paraphrasing it, and give tool-less phases the same one-turn budget.
  That narrows the confound. It does not remove it, and a determined reader should treat small
  score differences as partly attributable to prompt wording rather than to architecture.
- **Cost is what the SDK reported, not what you were billed.** Per-call cost comes from the
  terminal `result` message. Caching, rate limiting and retries can make your invoice differ.
- **Wall-clock latency is measured on whatever machine ran the benchmark**, and parallel phases
  contend with each other. Treat latency as an ordering signal, not an absolute.

---

## A note on `npm audit`

`npm audit` reports advisories in this tree. They are left in place deliberately, because every
available "fix" is a major-version downgrade that would be worse than the advisory:

| Advisory path | Reported fix | Why it is declined |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk` → `@hono/node-server` | downgrade the Agent SDK to 0.2.85 | Rolling the SDK back across a major version to patch a Windows path-traversal bug in a transitive HTTP adapter we never serve traffic from. The pinned `0.3.220` is the version this harness is written against. |
| `vitest` → `vite` → `esbuild` | change vitest major | esbuild's dev-server advisory applies to a dev server we do not run; vitest is a devDependency and never ships. |
| `next` → `postcss` / `sharp` | downgrade `next` to 9.3.3 | Downgrading Next.js by six major versions to patch build-time-only CSS and image tooling. The site is statically rendered from committed JSON and accepts no user input. |

None of these are on a path that processes untrusted input in this project: the benchmark runner
reads its own results, the site renders committed JSON, and the test and build toolchains never
run in production. `npm audit fix --force` would take all three downgrades and break the
benchmark. Re-evaluate when upstream ships non-breaking fixes.

---

## Licence

MIT — see [LICENSE](LICENSE).
