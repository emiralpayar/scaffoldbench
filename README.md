# ScaffoldBench

Everyone argues about agent architectures. Should the agent plan first, or just act? Does a
verifier pay for itself? Is fanning work out to parallel subagents worth the coordination risk?
The arguments are made from anecdote, and almost nobody publishes a number. ScaffoldBench is a
benchmark lab for exactly that question: it runs **six agent harness architectures** over the
**same task set**, on the same model, through the same instrumentation, and reports score, cost
and latency with bootstrap confidence intervals. The tasks are held constant so that a difference
in the leaderboard is a difference in the *architecture* — not in the model, the prompt, the
toolset or how carefully somebody measured.

The first real run set is in. Its headline is not a winner but a ceiling: on Claude Sonnet 5 the
nine sandbox tasks are too easy to separate the five architectures, every pairwise comparison comes
back `inconclusive`, and the cheapest architecture does the same work at a fifth the price. That
is reported as it stands, in [Results](#results) and [Limitations](#limitations), rather than
dressed up as a ranking — a benchmark that cannot admit a null result is not measuring anything.

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

**A tool surface pinned to the task.** `settingSources: []` turned out not to be sufficient on its
own. Reading an `init` message during development showed the session still loading its own agent
tools — `Task`, `Skill`, `Workflow`, `ToolSearch`, the scheduling tools — into every run. The
permission mode kept them uncallable, so nothing was *wrong* in the results, but they still
occupied the prompt and their exact set depends on the host: two runs of the same task on two
machines would not have been comparable. Every call now pins `tools` as well as `allowedTools`, so
the model is shown exactly the task's toolset and nothing else.
([`runQuery.ts`](packages/core/src/runQuery.ts))

**Record/replay fixtures for the research half.** The research tasks reach the web through two
tools of our own, `search` and `fetch_page`, backed by a content-addressed fixture store. `record`
mode performs real requests and writes them to disk; `replay` mode — the default for CI and for
the weekly benchmark — never touches the network. Two strategies compared on a live web are
compared on two different webs.

Replay matches on more than the exact request, and it has to. Keying strictly on the query string
looked correct and was unusable: a recording answers only the wording that produced it, and no two
runs word a search the same way. Replaying a *freshly recorded* research task missed on all sixteen
of its searches and scored 0.08 — a number about fixture bookkeeping, not about the architecture.
A miss now falls back to the closest recorded query by content-word overlap, then to the recorded
pages themselves, so any sensible phrasing reaches sources that were captured. `fetch_page` is
held to a stricter rule — same host, and a match on the path tail that names the page — because a
substituted page reads to the agent as a real source, where an off-target search result is merely
ignored. The same task then scored 1.00.
([`webTools.ts`](packages/tasks/src/research/webTools.ts), [`fixtureStore.ts`](packages/tasks/src/research/fixtureStore.ts))

**Bootstrap confidence intervals, and an explicit `inconclusive`.** Every estimate carries a
task-clustered bootstrap interval from a seeded PRNG, so the intervals are reproducible across
report runs, and strategies are compared pairwise on the same (task, repeat) cells with
Holm-adjusted verdicts: better, worse, equivalent within a stated margin, or `inconclusive`. With
a handful of repeats that is usually the honest answer, and the report says so instead of ranking
noise. ([`analysis.ts`](packages/core/src/analysis.ts), [method](docs/STATISTICS.md))

**Judge cost tracked separately from strategy cost.** Research rubrics are graded by a model. That
grading is billed to `judgeCostUsd` on the run record and never to `costUsd`, because folding
grading spend into a strategy's cost would make an architecture look expensive for reasons that
have nothing to do with it. The judge is also sampled several times and reduced by median, so one
unlucky grading cannot move a headline number.
([`judge.ts`](packages/core/src/judge.ts))

**One choke point to the model.** Every strategy reaches the model through a single function,
`runQuery`. Trace capture, cost accounting, the sandbox guard, the hermetic settings, the abort
handling and the budget ceiling are therefore identical for every architecture. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## The six architectures

| id | Name | What it does |
| --- | --- | --- |
| `single` | Single agent | One agent, one context, the full toolset, no separate planning or review step. The control condition every other row has to beat. |
| `plan-execute` | Plan then execute | A tool-less planning call writes an ordered list of steps; a second call executes them with the full toolset. |
| `orchestrator-workers` | Orchestrator with parallel workers | An orchestrator splits the task into up to four independent subtasks, runs them concurrently in separate contexts, then synthesizes the answer from their reports. |
| `plan-execute-verify` | Plan, execute, verify, revise | Plan and execute, then a verifier holding only the read-only tools checks the real state rather than the executor's account of it and answers through a schema; a rejection with a blocking issue goes back for revision, at most twice. An unreadable verdict is asked for once more, never assumed to be approval. |
| `propose-select` | Parallel proposals, select, execute | Three proposers investigate in parallel with read-only tools, each starting from a different angle (policy, current state, the user's outcome); a selector picks the strongest and merges in what the others got right, and a final call applies it with the full toolset. Formerly `debate-select`: the proposers never see one another, so there was never a debate. |
| `gated-execute` | Execute with action review | One executor with the full toolset, but every call that would change state is first put to a read-only reviewer holding the domain policy, which checks the current state and allows or denies it; a denial comes back to the executor as the tool's result, with the reason, so it can adapt. Review at the point of action instead of after the fact. |

Strategies are pure orchestration: they never import the SDK, they take `runQuery` as an injected
dependency, and every phase builds on the same base system prompt rather than replacing it. Every
acting phase gets the same instructions word for word, and every phase gets turns by one policy
for its kind (the task's own allowance for a phase with tools, three for a tool-less schema phase,
one for tool-less prose), so no design is quietly handed a better brief than another. Totals are
not equalised; the per-run cost cap is the shared ceiling, as
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#turn-budgets) explains. Each architecture also
declares its own invariants — the plan was a plan, the fan-out fanned out, the verdict was read —
and a run in which it silently fell back on a default fails its integrity check instead of being
ranked.

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
git clone <this repo> && cd scaffoldbench
npm install            # Node 22+
cp .env.example .env   # then put a real key in ANTHROPIC_API_KEY
```

List what is available:

```bash
npm run bench -- tasks        # every task: id, world, category, difficulty
npm run bench -- strategies   # the six architectures and what each one does
npm run bench -- --help
```

A cheap first run — two architectures, one task, one repeat, on the fast model:

```bash
npm run bench -- run \
  --strategies single,plan-execute \
  --tasks airline-easy \
  --repeats 1 \
  --model claude-sonnet-5
```

`--tasks` accepts ids, whole worlds, categories and globs — `--tasks airline-*`, `--tasks research`,
`--tasks support,ecommerce-hard` — so you rarely have to type twelve ids.

> **Record the research fixtures before you run the research half.** Runs default to `--replay`,
> which reads recorded pages and never touches the network. On a fresh clone `fixtures/` is empty,
> so every `search` and `fetch_page` returns *"no recording exists"* and all three research tasks
> score near zero — for every architecture, which looks like a finding and is not one. Populate it
> once, with any single architecture, then commit what it captured:
>
> ```bash
> npm run bench -- run --strategies single --tasks research --repeats 1 --record
> git add fixtures && git commit -m "Record research fixtures"
> ```
>
> Every later run replays those pages, so the research half is then free, offline and identical
> between runs. The tool-use half needs none of this — its worlds are in-memory and always ready.

Then aggregate and read it:

```bash
npm run bench -- report             # leaderboard, per-cell matrix, pairwise verdicts, Pareto frontier
npm run bench -- report --markdown  # the same, also written to results/<runSetId>/REPORT.md
npm run bench -- report <runSetId>  # any stored run set; defaults to results/latest.json
```

And browse it, including per-run traces:

```bash
npm run dev:web   # http://localhost:3210
```

The site also has a **`/live`** page: pick one task and one architecture, paste your own API key,
and watch a single run stream — tool calls, subagents, anything the sandbox guard blocks, and the
deterministic score at the end. It is the fastest way to see what the aggregate numbers are made
of. The run is capped at $0.50 and four minutes, is never written to `results/`, and never reaches
the leaderboard.

That endpoint is the one place the project handles somebody else's credentials, so it is worth
being precise about what it does. The Agent SDK resolves credentials from the subprocess
environment in a documented order — API key, then auth token, then an on-disk OAuth profile, then
platform variables. A server that simply spread `process.env` and added the visitor's key could
therefore fall through to its *own* credentials and bill the operator for a stranger's run. So the
run executes under [`visitorEnv`](packages/core/src/credentials.ts), which deletes every one of
those sources before setting the supplied key. The behaviour is
[tested](packages/core/test/credentials.test.ts), and was confirmed against a machine that does
have ambient credentials: an invalid key fails with a 401 rather than quietly succeeding on the
host's account.

Other useful commands:

```bash
npm run check         # typecheck + the full test suite
npm run check:wiring  # canary: starts a real SDK session and asserts the MCP tools register
npm run demo:data     # fabricate a run set so the site can be developed without spending anything
```

`npm run demo:data` writes `apps/web/demo-data/demo-synthetic` (gitignored, never `results/`) with
`synthetic: true` in its manifest. The site reads it only under `SCAFFOLDBENCH_DEMO=1 npm run dev:web`, and
renders an unmissable banner because of it. Those numbers are invented and exist only so the
interface can be reviewed. They are not results.

---

## Cost control

A full matrix is six strategies x twelve tasks x N repeats, and several of the architectures make
four or more model calls per run. Left unchecked that gets expensive quickly, so there are four
brakes:

- **Per-run ceiling** — `--max-cost` (default $1.00, or `SCAFFOLDBENCH_MAX_COST_USD`) and `--max-seconds`
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

First real run set: **`2026-07-25T20-18-35Z-3fs5`** — five architectures over the nine sandbox
tasks, two repeats, Claude Sonnet 5 at `effort: high`, replay fixtures. 90 of 90 runs completed in
23 minutes for $9.11, with zero harness errors and zero sandbox-guard violations. Regenerate or
extend it with `scaffoldbench report --markdown`, which writes `results/<runSetId>/REPORT.md`.

| Strategy | n | Mean score (95% CI) | Pass rate | Mean cost | Mean latency | Score per $ |
| --- | --- | --- | --- | --- | --- | --- |
| `debate-select` (now `propose-select`) | 18 | 1.000 [1.000, 1.000] | 100% | $0.187 | 1m10s | 5.3 |
| `single` | 18 | 0.990 [0.970, 1.000] | 94% | $0.050 | 22s | **19.7** |
| `plan-execute` | 18 | 0.990 [0.970, 1.000] | 94% | $0.070 | 33s | 14.1 |
| `plan-execute-verify` | 18 | 0.990 [0.970, 1.000] | 94% | $0.109 | 52s | 9.1 |
| `orchestrator-workers` | 18 | 0.980 [0.950, 1.000] | 89% | $0.089 | 44s | 11.0 |

**All ten pairwise comparisons come back `inconclusive`, and that is the correct answer.** The
task set saturates: eight of the nine tasks score 1.00 for every architecture. The only cell with
any spread is `ecommerce-hard` — whether returned units get restocked while cancelled ones do —
and there the miss moves *within* a strategy between repeats rather than between strategies
(`single` gets it on repeat 1 and misses on repeat 2; `plan-execute` does the reverse). That is
noise, not an architectural difference.

Read honestly: **on this task set and this model, none of the extra architectural layers earns its
cost back.** `single` does the same work at a fifth the price of `debate-select` and in a third of
the wall-clock time. That is a real finding, and it is simultaneously a limit of the task set
rather than a verdict on the architectures — see [Limitations](#limitations). The remedy is harder
tasks, not a ranking.

The report also emits the per-cell matrix, the failure-mode breakdown, the pairwise verdicts
(including every `inconclusive` one) and the score/cost Pareto frontier.

---

## What running it actually surfaced

A benchmark harness is itself software, and six defects in this one survived a green test suite,
a clean typecheck and a passing MCP wiring canary. None was findable without a live model. They
are listed here because they are the most transferable thing in the repository — anyone building
an agent harness will meet some of them.

1. **The tool surface leaked, and varied by host.** `settingSources: []` was not sufficient.
   Reading an `init` message showed the session also loading its own agent tools — `Task`, `Skill`,
   `Workflow`, `ToolSearch`, the scheduling tools — into every run. The permission mode kept them
   uncallable, so no result was *wrong*, but they occupied the prompt and their exact set depends
   on the machine, so two runs of the same task were not comparable. Fixed by pinning `tools`
   alongside `allowedTools`.

2. **Exact-key replay was unusable.** A recording answers only the wording that produced it, and
   no two runs word a search the same way. Replaying a *freshly recorded* research task missed on
   all sixteen of its searches and scored 0.08 — a number about fixture bookkeeping, not about the
   architecture. Fixed with corpus near-matching; the same task then scored 1.00.

3. **A truncated turn discarded the whole run.** Hitting the turn cap or the budget returned an
   error result with no text, so a dozen genuine page fetches scored zero for want of a closing
   message. The work is in the transcript, so `runQuery` now recovers the last assistant text. A
   truncated run is a valid data point; a silently empty one is not.

4. **Resolving the repo root broke under a bundler.** `import.meta.url` at module scope took the
   entire web build down with `must be of type string or an instance of URL. Received an instance
   of URL` — a bundler rewrites it so the `URL` reaching `fileURLToPath` comes from another realm.

5. **The live demo could have billed the operator.** Spreading `process.env` and adding a
   visitor's key lets the SDK fall through to the host's own credentials. Confirmed on a machine
   that has an ambient Claude Code login: before the fix an invalid key silently succeeded on the
   host's account; after it, the same key correctly fails with a 401.

6. **The CLI rejected a working credential setup.** `scaffoldbench run` exited without `ANTHROPIC_API_KEY`,
   but the SDK resolves credentials in its own order and an interactive Claude Code login is a
   perfectly good one. It now reports which account will be billed and lets the request decide.

Two mechanisms earned their keep on the first live data. The citation audit caught a genuine
fabrication — the agent cited an MDN page it had never opened, 7 of 8 citations verified, penalty
applied. And the sandbox traces follow the intended solution path: read the reservation, read the
rules, fetch the passenger tier with a second call because it is deliberately absent from the
reservation, then make two coordinated mutations with the tier bonus applied correctly.

---

## Repository layout

```
packages/core/        contracts, runQuery, budget, trace, sandbox guard, judge,
                      scoring, bootstrap statistics, the matrix runner, aggregation
packages/strategies/  the six harness architectures, plus the shared phase runner
packages/tasks/       the task factories and the task set:
                        defineToolUseTask.ts   deterministic sandbox tasks
                        worlds/{airline,ecommerce,support}/  world, tools, tasks
                        research/              web tools, fixture store, research tasks
apps/cli/             the `scaffoldbench` command (run · report · tasks · strategies)
apps/web/             Next.js site rendering a stored run set — leaderboard, per-cell
                      matrix, score/cost frontier, run detail, traces, and the
                      /live page that runs one task on the visitor's own key
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

- **The current task set saturates — this is the biggest limitation, and it is measured, not
  suspected.** On the first real run set, eight of the nine sandbox tasks scored 1.00 for every
  architecture on Claude Sonnet 5, and all ten pairwise comparisons were `inconclusive`. A
  benchmark whose tasks everything solves cannot separate anything. The nine tasks were designed to
  need state discovery, a rule lookup and coordinated mutations, and they do — but a current
  frontier model clears that bar comfortably. **Do not read the present leaderboard as a ranking of
  architectures; read it as the task set running out of headroom.** The fixes, in order of value:
  harder tasks with more rule interactions ([docs/ADDING-A-TASK.md](docs/ADDING-A-TASK.md)); the
  research half, which showed real variance in single runs (1.00 / 0.86 / 0.49) and has not yet
  been put through the full matrix; and tighter `--max-cost` and turn caps, which test the
  architectures under resource pressure and need no new code.
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
  the phases symmetric: all six build on the identical base system prompt, quote the user's
  request verbatim rather than paraphrasing it, give every acting phase the same instructions word
  for word, and set every phase's turns by one policy.
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
