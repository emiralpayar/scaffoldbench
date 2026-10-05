# The leaderboard said five architectures tied. The traces said four of them never ran.

*ScaffoldBench post-mortem, Act 1.* The interactive version, with replays of the recorded traces,
is the site's [`/postmortem`](https://emiralpayar.github.io/scaffoldbench/postmortem/) page.
The evidence is committed: the 90 run records and all 90 traces of
[`results/2026-07-25T20-18-35Z-3fs5`](../results/2026-07-25T20-18-35Z-3fs5). Every number below
can be re-derived from those files with the commands in [Reproduce it](#reproduce-it), and the
headline counts are pinned by [`apps/web/test/postmortem.test.ts`](../apps/web/test/postmortem.test.ts),
which fails the build if one of them stops matching the evidence.

This is written for engineers who build agent harnesses. The bugs are ordinary. What is worth
reading is how four broken architectures produced a clean, plausible, wrong conclusion, and why a
green test suite had no way to notice.

**In short**

- Five architectures scored between 0.980 and 1.000 on 90 runs. We wrote that up as "all
  inconclusive" and "single does the same work at a fifth the price".
- In the traces, every planner, decomposer and selector, 72 of 72, ended in an error. The executors
  got an empty `<plan></plan>`. The orchestrator never split a task. The second and third
  proposers started with no tools, and the verifier never sent anything back.
- There were four root causes: a sandbox guard that denied the SDK's own `StructuredOutput` tool,
  one MCP server instance shared by concurrent sessions, a verifier that was never given its
  schema, and sessions that were not hermetic.
- 437 tests passed because the fake model call returned structured output whether or not the code
  asked for it. The mock sat above the seam where the bugs were.
- Now a run that did not execute as designed is excluded and reported, not ranked.

---

## 1. The result we almost published

The first full run set: five architectures on the nine base tool-use tasks, two repeats, one model
(recorded as `claude-sonnet-5`, effort `high`), measured at commit `164f958`. All 90 runs completed,
in 23 minutes, for $9.11.

| Strategy | n | Mean score (95% CI) | Pass rate | Mean cost | Mean latency | Score per $ |
| :--- | ---: | :--- | ---: | ---: | ---: | ---: |
| `debate-select` | 18 | 1.000 [1.000, 1.000] | 100.0% | $0.1873 | 1m10s | 5.3 |
| `single` | 18 | 0.990 [0.970, 1.000] | 94.4% | $0.0503 | 22.4s | 19.7 |
| `plan-execute` | 18 | 0.990 [0.970, 1.000] | 94.4% | $0.0702 | 32.9s | 14.1 |
| `plan-execute-verify` | 18 | 0.990 [0.970, 1.000] | 94.4% | $0.1093 | 52.4s | 9.1 |
| `orchestrator-workers` | 18 | 0.980 [0.950, 1.000] | 88.9% | $0.0892 | 43.6s | 11.0 |

*From [`REPORT.md`](../results/2026-07-25T20-18-35Z-3fs5/REPORT.md), as the report of the time
rendered it.*

The write-up went into the README in commit `7ccb437`, before the repository was public. Verbatim:

> 90 of 90 runs completed in 23 minutes for $9.11, with zero harness errors and zero
> sandbox-guard violations.
>
> **All ten pairwise comparisons come back `inconclusive`, and that is the correct answer.** The
> task set saturates: eight of the nine tasks score 1.00 for every architecture.
>
> Read honestly: **on this task set and this model, none of the extra architectural layers earns
> its cost back.** `single` does the same work at a fifth the price of `debate-select` and in a
> third of the wall-clock time.

It read as a careful null result. It hedged on saturation, it fit a widely held prior that simple
agents are hard to beat, and nothing in the run records contradicted it: 85 of the 90 runs were
recorded with `failureMode: "none"`. Even its arithmetic was generous. $0.050 against $0.187 is
27%, and the paired cost ratio is 3.94× [3.23, 4.72], so "a quarter" would have been closer than
"a fifth".

The same records also held 70 guard denials, one in each of 70 runs, and an error on 72 phases.
None of it surfaced, because the report never looked at those fields.

## 2. What the traces showed

Before publishing, we read the traces. An architecture is a claim about what calls happen, with
which inputs and which tools, and each claim can be checked against what each session recorded.

| Architecture (as recorded) | Designed to | What ran | Receipt |
| :--- | :--- | :--- | :--- |
| `single` | One agent with the full toolset | As designed | 0 errored phases, 0 guard denials in 18 runs |
| `plan-execute` | A tool-less planner writes a plan, then an executor carries it out | An executor with an empty plan: a single agent | The plan phase errored in 18 of 18 runs |
| `plan-execute-verify` | Plan, execute, then a read-only verifier sends rejected work back for revision | A single agent, followed by a reviewer whose verdict was never read | The plan phase errored in 18 of 18 runs. 0 of 18 runs were revised |
| `orchestrator-workers` | Split the task into up to four subtasks, run workers in parallel, synthesize | One worker with the whole task, then a summary | The decomposition errored in 18 of 18 runs. All 18 ran `decompose > worker-all > synthesize` |
| `debate-select` (now `propose-select`) | Three proposers investigate in parallel; a selector picks; an executor applies | One proposer with tools; its proposal chosen by default; an executor | 36 of 36 second and third proposer sessions started with their MCP server `failed` and 0 tools. The selector errored in 18 of 18 runs |

Across the set:

| Count | What it is |
| ---: | :--- |
| **72 / 72** | plan, decompose and select phases that ended in an error, every one of them `Reached maximum number of turns (1)` |
| **70** | guard denials, every one of them of `StructuredOutput` (34 in plan, 18 in decompose, 18 in select) |
| **35 / 36** | executor calls handed an empty `<plan></plan>` |
| **0 / 18** | orchestrator runs that split the task |
| **36 / 36** | second and third proposers that started with none of the task's tools |
| **0 / 18** | verified runs sent back for revision |
| **70 / 252** | sessions whose init listed claude.ai connectors from the operator's own account |
| **108 phases, $2.43 of $9.11** | spent on phases that errored or ran blind |

These are the values of `ACT_ONE` in [`apps/web/lib/postmortem.ts`](../apps/web/lib/postmortem.ts).
The test re-derives every one of them from the committed records and traces.

### The planner never planned

Every schema phase asked for its answer through the SDK's `StructuredOutput` tool, which the SDK
adds to the session when a call sets an output format. Here is the plan phase of
`plan-execute__airline-easy__r1`:

```json
{"kind":"tool_call","toolName":"StructuredOutput","text":null}
{"kind":"tool_denied","toolName":"StructuredOutput","text":"Blocked by sandbox guard: StructuredOutput is not part of this task's toolset."}
{"kind":"error","toolName":null,"text":"Claude Code returned an error result: Reached maximum number of turns (1)"}
```

The planner had one turn. It spent that turn on the denied call, so no plan came back. The
executor's prompt in the same run:

```text
<task>
Rosa Mendel is flying to Seattle on reservation R1042 and wants to add two more checked bags. …
</task>

<plan>

</plan>

Carry out the task following the plan above. …
```

35 of the 36 plans handed to an executor look like this. The 36th, in
`plan-execute-verify__ecommerce-hard__r2`, is the planner's last words, recovered by a
salvage path that was meant for truncated answers:

```text
<plan>
Provide StructuredOutput.
</plan>
```

Two of the 36 planner errors were not denials. The model's `StructuredOutput` call failed input
validation (`InputValidationError: StructuredOutput was called with input that could not be
parsed as JSON.`), and the one-turn budget left no turn for a retry.

One more detail: the planner's prompt says "You have no tools here", but in all 36 planner sessions
the init message still listed the task's MCP tools. They could not be called. They were still in
the prompt.

### A verifier that could not say no

All 18 `plan-execute-verify` runs had exactly three phases: `plan > execute > verify`. The revise
loop never ran once. `VERIFY_SCHEMA` was defined in the strategy and never passed to the call, so
every verdict came back as prose. The parser treated a reply it could not read as approval
(`if (parsed === undefined) return { approved: true, … }` at `164f958`).

One verified run scored below 1.0: `plan-execute-verify__ecommerce-hard__r1`, at 0.818. It failed the
assertion "Cancelled units were restocked and returned units were not". The verifier read the
inventory, saw the restock, and wrote:

```text
All checks confirm the executor's work is correct and complete.
```

That was the model's mistake. The harness's mistake is that a rejection would have been read as
approval too.

### One worker, the whole task

The orchestrator's `decompose` call was a schema call, so it failed exactly as the planner did, in
18 of 18 runs. When the decomposition cannot be read, the strategy falls back to one worker that
gets the whole task. Every orchestrator run in the set has the same phase sequence:
`decompose > worker-all > synthesize`. Each "orchestrator-workers" run was a single agent followed
by a summary of its own report.

### One proposer with tools

`debate-select` started three proposers in parallel. Each session's init message records the MCP
servers it connected to:

```json
{"phase":"propose-1","mcpServers":[{"name":"airline","status":"connected"}],"tools":16}
{"phase":"propose-2","mcpServers":[{"name":"airline","status":"failed"}],"tools":0}
{"phase":"propose-3","mcpServers":[{"name":"claude.ai Google Drive","status":"needs-auth"},{"name":"claude.ai Gmail","status":"needs-auth"},{"name":"claude.ai Google Calendar","status":"needs-auth"},{"name":"airline","status":"failed"}],"tools":0}
```

The pattern held in all 18 runs: proposer 1 connected, and proposers 2 and 3 had a `failed` task
server and zero tools. With nothing to call, proposer 2 in `debate-select__airline-easy__r1` wrote
a tool call as prose, naming a tool that does not exist (the real one is `get_reservation`):

```text
I'll investigate the reservation, passenger frequent-flyer status, and baggage rules before proposing an action.

get_reservation_details {"reservation_id": "R1042"}
```

The selector was a schema call. Its `StructuredOutput` was denied in all 18 runs, and the
strategy's default `winnerIndex` of 1 picked the only proposal made with tools. So
"debate-select" ran as one investigator plus one executor, plus two blind guesses that nobody read.

### Sessions that were not hermetic

70 of the 252 session inits listed three servers the harness never configured: `claude.ai Gmail`,
`claude.ai Google Drive` and `claude.ai Google Calendar`. These are connectors attached to the
operator's own claude.ai account, and all of them reported `needs-auth`. They show up in every
kind of phase, from plan and execute to proposers, workers and the verifier, and in no fixed
subset of the runs. They were inert only because they were unauthenticated. On a machine where
they were authenticated, their tools would have entered the prompt, and two runs of the same cell
would no longer have been the same experiment.

### Why the scores still looked right

A phase that errored did not fail its run. The next phase still had the task. The planner failed,
so the executor did what a single agent does. The decomposer failed, so one worker did the whole
job. The selector failed, so proposal 1 won, and proposal 1 was the only one with tools. In every
case the final agent was effectively a single agent, so it scored like one. The five runs below
1.0 all missed the same assertion on the same task (`ecommerce-hard`, restocking returned goods
that the warehouse had not received). They were spread across four architectures, single included.

Every number on the leaderboard was real. The comparison it invited was between designs that had
not run.

## 3. Root causes, and the fix for each

| # | Cause | Effect in the run set | Fix |
| :--- | :--- | :--- | :--- |
| 1 | The sandbox guard allowed only a phase's task tools, so it denied the `StructuredOutput` tool the SDK injects for a schema call. Schema phases also had one turn (`REASONING_TURNS = 1`) | 72 of 72 plan, decompose and select phases errored | `5881abe` |
| 2 | Every call in a run was handed the same in-process MCP server instance. An MCP server accepts one transport at a time | Parallel proposers 2 and 3 started with `failed` servers and no tools, in 36 of 36 sessions | `fc9c6ea` |
| 3 | `plan-execute-verify` defined `VERIFY_SCHEMA` and never passed it. An unreadable verdict was read as approval | 0 of 18 verified runs revised. The revise loop was dead code | `c647245` |
| 4 | Sessions inherited the operator's environment. `settingSources: []` does not cover claude.ai connectors or a host Claude Code session's variables | 70 of 252 sessions listed the operator's connectors | `5881abe`, `3632d93`, `11e6421` |

**1. The harness's own tool.**
[`packages/core/src/runQuery.ts`](../packages/core/src/runQuery.ts) now adds `StructuredOutput`
(`STRUCTURED_OUTPUT_TOOL` in [`hermetic.ts`](../packages/core/src/hermetic.ts)) to the allowlist
whenever a call sets `outputSchema`, and [`guard.ts`](../packages/core/src/guard.ts) lets it
through. A schema call gets at least `SCHEMA_MIN_TURNS = 3` turns, so a reply that fails validation
can be retried, and a schema call that ends without structured output is reported as
`structuredMissing` instead of being swallowed.

**2. One server per call.**
`TaskEnvironment.createMcpServers({ only })`, built by `createJournaledToolServer` in
[`packages/core/src/tools.ts`](../packages/core/src/tools.ts), is called by `runQuery` once per
call. Every instance shares the same world and tool journal, so state is still shared; only the
protocol endpoint is new. The same filter fixes what a phase is shown: a tool-less phase gets no
task server, and a read-only phase gets a server that holds only the read-only tools.

**3. A verdict that counts.**
[`packages/strategies/src/planExecuteVerify.ts`](../packages/strategies/src/planExecuteVerify.ts)
passes `VERIFY_SCHEMA`. If a verdict cannot be read, the verifier is asked once more, with its own
notes. If it still cannot be read, the review ends with no verdict, the phase is marked
`degraded` and the run fails integrity. Nothing is approved by default. The same rule now holds in
every architecture: no fallback is silent. A default winner, a decomposition that could not be
read and a plan written in prose are all recorded as `degraded`.

**4. Hermetic sessions.**
Every model call, the judge included, starts from `hermeticOptions()` in
[`packages/core/src/hermetic.ts`](../packages/core/src/hermetic.ts). `settingSources: []` comes
with `strictMcpConfig: true`, `disableClaudeAiConnectors: true`, `tools` pinned so no Claude Code
built-in tool is offered, and an environment stripped of the variables a host Claude Code session
passes down. Two checks verify the result for every call: `harness.mcp-hermetic` (no MCP server the
harness did not configure) and `harness.builtin-tools` (no built-in tool offered).

## 4. Why 437 green tests missed it

At `164f958`, 437 tests passed, the code typechecked, and an MCP wiring canary passed. None of them
could have failed on these bugs.

**The mock sat at the wrong seam.** The strategy tests replaced `runQuery` with a fake that answered
by phase name:

```ts
/** Structured replies that satisfy every phase of every strategy. */
const genericScript: Script = (spec) => {
  if (spec.phase === 'plan') {
    return { text: 'plan prose', structured: { steps: ['read the order', 'refund it'], rationale: 'safe' } };
  }
  // …
  if (spec.phase === 'verify') {
    return { text: 'looks good', structured: { approved: true, issues: [], severity: 'none' } };
  }
```

The fake returned a structured verdict to a verifier that had never asked for one. It never checked
`spec.outputSchema`, so the missing schema could not show up. The guard, the turn cap and the MCP
server all lived below the fake, so none of those bugs could show up either. The tests checked
that the orchestration logic did the right thing given well-formed replies. They could not check
whether well-formed replies were possible.

**The only real-SDK check started one session.** `scripts/check-wiring.ts` starts a real Agent SDK
session against a task's MCP server and checks that the tools register. It did, because one
session connected fine. The bug needed a second session at the same time.

**Nothing asked whether each architecture ran.** Every check measured whether the code completed.
None measured whether the design executed.

The replacement is
[`packages/strategies/test/realSeam.test.ts`](../packages/strategies/test/realSeam.test.ts). It
drives every architecture through the real `runQuery`, the real sandbox guard and real per-call MCP
servers, against a scripted SDK
([`packages/core/test/support/fakeClaudeCode.ts`](../packages/core/test/support/fakeClaudeCode.ts))
whose MCP connections use the real protocol object, so a shared server fails there the way it
fails in production. It then computes the integrity checks on the output. Each architecture's
normal run must pass all of them, and a degraded run of each must fail. The strategy-level fake
stays for what it is good at: pinning orchestration logic and every fallback.

## 5. What the harness does now

**A fidelity gate.** Every run record carries `integrity: { ok, checks[] }`
([`integrity.ts`](../packages/core/src/integrity.ts),
[`fidelity.ts`](../packages/strategies/src/fidelity.ts)). The harness checks cover the same failures
as Act 1:

- the guard never denied a harness tool (`harness.harness-tools`)
- every configured MCP server was `connected` (`harness.mcp-connected`), and no other server loaded
  (`harness.mcp-hermetic`)
- no built-in tool was offered (`harness.builtin-tools`)
- every schema call got its structured output (`harness.structured-output`)
- no phase fell back on a default (`harness.not-degraded`)

Each architecture adds its own invariants: the plan was read from the schema reply, every planned
worker ran, all three proposers ran with their tools, every verdict was read and the loop did what
it said. A run with `ok: false` is excluded from every ranking and counted on the site's health
page. The legacy run set predates the gate, so `scaffoldbench report` renders it as "ranked but
unverified" and the site labels it the same way. Its records cannot be put through the real
checks. Approximating the gate with "any phase ended in an error" still excludes 72 of its 90
runs. Only `single` survives, and with one architecture left there is no comparison to make.

**An API failure is never a wrong answer.** A failed model call comes back on
`QueryOutcome.apiError`, never as answer text. The run is recorded as `api_error` and left
unscored. It is excluded from analysis and re-run by `--resume`. The runner stops a run at its
first API failure instead of paying for the remaining phases.

**Paired, task-clustered statistics with four-way verdicts.** "All inconclusive" was read as "no
difference". Under [the current analysis](STATISTICS.md) a contrast can be better, worse,
equivalent within a stated margin, or inconclusive. On the legacy set every score contrast is
inconclusive, which here means *no information*. `debate-select` against `single` gives
Δpass +0.056 [0.000, 0.222], so the set could not rule out a 22-point pass-rate edge. The old
report printed `debate-select`'s score as 1.000 [1.000, 1.000] and compared arms by whether their
intervals overlapped. In simulation with five identical strategies, 9 tasks and 2 repeats, that
overlap rule names a false winner in 21% of run sets, against 0% for paired comparisons with Holm
correction
([`analysisSimulation.test.ts`](../packages/core/test/analysisSimulation.test.ts)). The one thing
the legacy data does show clearly is cost. Every scaffold cost more than `single` in 18 of 18
paired cells: overhead that, as section 2 shows, mostly did nothing.

**Pre-registration.** The next run set, *Scaffold or Scale?* (3 models × 6 architectures × 25
tasks × 2 repeats), is [pre-registered](PREREGISTRATION.md). Its hypotheses, exclusion rules,
analysis and a publication gate were fixed and tagged `prereg-v1` before its first run. The
measurement code under `packages/` is frozen at that tag. A null result is no longer free to take
whatever shape it happens to have.

## 6. Lessons that transfer

1. **Check that the design ran, per run, from the trace.** A score says the final answer was
   right. It does not say the planner planned. Write each architecture's invariants down as checks,
   and exclude a run that fails them.
2. **Mock the boundary you do not own, and make the mock as strict as the real thing.** A fake that
   returns structured output to a call that never asked for it is testing a better world than the
   one you run in. A scripted SDK under your real call path catches the bugs that live in the call
   path.
3. **A fallback is a silent change of architecture.** "Use proposal 1 if the selector fails" is
   reasonable product code and fatal benchmark code. Record every fallback as a degradation and
   fail the run on it.
4. **Test the second concurrent session.** Shared resources, here an MCP transport, break only when
   two callers use them at once. A one-session canary proves the wiring works for one session.
5. **The SDK's own tools are tools.** An allowlist built from "the task's tools" denies whatever the
   SDK injects, including the tool that delivers structured output. Read a session's init message:
   the surface a session has is what init lists, not what you configured.
6. **Hermeticity covers the account as well as the machine.** Settings files, MCP config files,
   account-level connectors and the parent process's environment are four different leaks, each
   with its own switch.
7. **"Inconclusive" is not "equivalent".** A null result from a broken harness looks exactly like a
   null result about the thing you meant to measure. Use a test that can say "equivalent", and say
   which one you have.
8. **Be most suspicious of the result you expected.** This one matched a popular prior, so it got
   less scrutiny than it needed.

---

## Reproduce it

Run from the repository root. Every command reads only committed files. The output each one gave at
the time of writing is in its comment.

```bash
R=results/2026-07-25T20-18-35Z-3fs5

# plan, decompose and select phases that ended in an error (72), and why
jq -s '[.[].phases[] | select(.phase | test("^(plan|decompose|select)$")) | select(.error)] | length' $R/runs/*.json
jq -r '.phases[] | select(.phase | test("^(plan|decompose|select)$")) | .error' $R/runs/*.json | sort | uniq -c

# guard denials over the set (70), and which tool they denied (StructuredOutput, every time)
jq -s 'map(.deniedToolCalls) | add' $R/runs/*.json
jq -r 'select(.kind == "tool_denied") | "\(.phase) \(.toolName)"' $R/traces/*.jsonl | sort | uniq -c

# the plans executors were handed (35 empty, 1 "Provide StructuredOutput.")
grep -ho '<plan>[^<]*</plan>' $R/traces/*.jsonl | sort | uniq -c

# what each multi-phase architecture actually ran, by phase sequence
jq -r 'select(.strategyId != "single") | "\(.strategyId): \([.phases[].phase] | join(" > "))"' $R/runs/*.json | sort | uniq -c

# each proposer's task server and tool count (proposers 2 and 3: failed, 0 tools, 18 of 18)
jq -r 'select(.kind == "system_init" and (.phase | startswith("propose-"))) | "\(.phase) \(.meta.mcpServers[] | select(.name | startswith("claude.ai") | not) | .status) tools=\(.meta.tools | length)"' $R/traces/*.jsonl | sort | uniq -c

# sessions whose init listed claude.ai connectors (70 of 252), and their status
jq -r 'select(.kind == "system_init") | [.meta.mcpServers[].name | select(startswith("claude.ai"))] | length > 0' $R/traces/*.jsonl | sort | uniq -c
jq -r 'select(.kind == "system_init") | .meta.mcpServers[] | select(.name | startswith("claude.ai")) | "\(.name) \(.status)"' $R/traces/*.jsonl | sort | uniq -c

# runs recorded with no failure mode although a phase had errored (68)
jq -s '[.[] | select((.phases | map(.error) | any) and .failureMode == "none")] | length' $R/runs/*.json
```

The site's page re-derives the record-level counts at build time
([`derivePostmortem`](../apps/web/lib/postmortem.ts)), and its test re-derives the trace-level ones
([`deriveTraceFacts`](../apps/web/lib/postmortem.ts)) from the committed traces on every `npm test`.

## Sources

- Evidence: [`results/2026-07-25T20-18-35Z-3fs5`](../results/2026-07-25T20-18-35Z-3fs5) (records, traces,
  `REPORT.md`), measured at commit `164f958`.
- Site: [`/postmortem`](https://emiralpayar.github.io/scaffoldbench/postmortem/), source in
  [`apps/web/app/postmortem/page.tsx`](../apps/web/app/postmortem/page.tsx).
- Fix commits: `5881abe` (structured output, turn floor, hermetic options, scripted-SDK tests),
  `fc9c6ea` (MCP servers per call), `c647245` (verifier schema and no default approval),
  `3632d93` (no built-in tools), `11e6421` (no host-session variables), `477c843` (halt on first
  API failure).
- Method: [`docs/ARCHITECTURE.md` §8](ARCHITECTURE.md#8-integrity-and-failure-modes) for the
  integrity checks, [`docs/STATISTICS.md`](STATISTICS.md) for the analysis, and
  [`docs/PREREGISTRATION.md`](PREREGISTRATION.md) for Act 2.
