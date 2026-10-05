# Contributing to ScaffoldBench

ScaffoldBench measures agent harness architectures (single agent, plan-execute, orchestrator-workers,
and so on) on the same models, tools and tasks. Contributions that make the measurement more
trustworthy are the most valuable ones: a sharper task, a bug in the harness, a check that catches a
run that did not do what it claims. Read the [README](README.md) first for what the benchmark is,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it is built and
[docs/STATISTICS.md](docs/STATISTICS.md) for how numbers become claims.

Please follow the [code of conduct](CODE_OF_CONDUCT.md). A security problem goes through a private
advisory instead of an issue: see [SECURITY.md](SECURITY.md).

## Set up

You need Node 22 or newer (`.nvmrc` pins 22) and npm.

```bash
git clone https://github.com/emiralpayar/scaffoldbench && cd scaffoldbench
npm ci
npm run check          # typecheck (CLI, packages and site) and every test
```

No API key is needed for any of that. The tests drive the real harness against a scripted SDK and
touch no network. Inside the repository the CLI is the `bench` npm script, so `scaffoldbench report`
is `npm run bench -- report`:

| Command | What it does | Cost |
| :--- | :--- | :--- |
| `npm run check` | Typecheck everything, run every test | free |
| `npm run build:web` | Build the static site into `apps/web/out` | free |
| `npm run dev:web` | The site on a dev server; `npm run demo:data` plus `SCAFFOLDBENCH_DEMO=1` shows a clearly marked synthetic run set | free |
| `npm run bench -- tasks` / `strategies` | List what can be selected | free |
| `npm run bench -- doctor` | Is this machine ready to run, and which account would be billed | free |
| `npm run bench -- run ... --dry-run` | Print the plan and the worst-case spend, then stop | free |
| `npm run bench -- report [runSetId]` | Render a stored run set | free |
| `npm run check:wiring -- --init-only` | Check tool registration against the real SDK, offline | free |
| `npm run bench -- run ...` | Run the benchmark | **spends money** |

To run anything that calls a model, copy `.env.example` to `.env` (it is gitignored) or use your
Claude Code login. Always pass `--max-cost` and `--total-budget`; `run` also prints a plan and asks
before it starts. Never commit a `.env`, a key or a trace that contains one.

## Code

TypeScript, strict, ESM. Match the code around you. Comments explain why something is the way it is,
not what the line does; a comment that records a failure the code now guards against is worth keeping.
There is no formatter to run, and `.editorconfig` sets whitespace.

`npm run check` must pass at every commit, not just the last one of a branch.

## Frozen measurement code

A pre-registration ([docs/PREREGISTRATION.md](docs/PREREGISTRATION.md)) fixes what the first
campaign measures and how it is analysed. Anything that changes what a run measures is frozen for
that campaign: scoring, the analysis in `packages/core`, the system prompt, the tool surface, and
the behaviour of an existing task or architecture. Fixes to those are welcome, but open an issue
first, because a change can make recorded runs incomparable with new ones. Renames, docs, tests, the
CLI and the site are not frozen.

Never edit anything under `results/` by hand, and do not change recorded run data to make a report
look different. Fix the code that reads it.

## Adding a task

[docs/ADDING-A-TASK.md](docs/ADDING-A-TASK.md) is the full walkthrough: a sandbox world, an expert
task with a back office and traps, or a research task against the frozen corpus. A task must prove
itself before it merges: the reference solution scores exactly 1, an untouched world scores exactly
0, every rule and trap is caught, and you have read a real trace of a single agent on it. Open a
[task proposal](https://github.com/emiralpayar/scaffoldbench/issues/new?template=task_proposal.yml)
first if you want a second opinion on the idea.

## Adding an architecture

An architecture is orchestration and nothing else: how many model calls, in what order, with which
tools, and what a phase that returns nothing does to the run. Prompts, tools and budgets are held
equal across architectures (see "Prompt parity" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), so a
design wins on its structure and not on better-worded instructions.

1. Write `packages/strategies/src/<name>.ts`. Take `runQuery` as an injected dependency
   (`StrategyDeps`) and build on `createPhaseRunner`; a strategy never imports the Agent SDK.
2. Write its fidelity checks (`<name>FidelityChecks`) next to it: the observable facts that prove a
   run was this architecture and not a single agent in disguise. Check ids start with the
   architecture id. A design that cannot be told apart from `single` by its trace is not ready.
3. Export it from `packages/strategies/src/index.ts` and add it to the **end** of `STRATEGIES`, so
   existing ids keep their place in reports.
4. Teach the site about it in `apps/web/lib/architectures.ts`, `designs.ts` and `glyphs.ts`;
   `apps/web/test/designs.test.ts` fails until all three describe the same set.
5. Test it twice. `strategies.test.ts` pins the orchestration with a fake `runQuery`, fallbacks
   included. `realSeam.test.ts` drives it through the real `runQuery`, sandbox guard and MCP servers
   against a scripted SDK: an ordinary run must pass every fidelity check and a degraded one must
   fail them.
6. Run it once for real against a cheap task, read the trace, and say what it cost in the PR.

An architecture added after the pre-registration is not part of the registered analysis. It can be
measured, and reported as exploratory.

## Commits and branches

- One logical change per commit, in the imperative, sentence case, no prefix and no trailing period:
  `Say when the analysis kept one of two healthy runs of a cell`.
- The subject is about 70 characters or fewer. The body explains why, and what you ruled out.
- Do not mix a rename or a reformat with a behaviour change.
- Rebase onto `main` rather than merging it into your branch.

## What a pull request must show

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) is the checklist. In short:

- `npm run check` passes, and `npm run build:web` does if the site or anything it imports changed.
- New behaviour has tests, and a bug fix has one that failed before the fix.
- A task or architecture comes with the evidence listed above.
- A site change comes with screenshots, light and dark, at desktop and phone width.
- Nothing under `results/` was edited by hand, and there are no secrets in the diff.
- If you ran paid benchmark runs, say what they cost and which command produced the numbers.

Small pull requests get reviewed faster than large ones. If you are not sure a change is wanted,
open an issue first.
