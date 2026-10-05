# Changelog

All notable changes to ScaffoldBench are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once it has a release.

## [Unreleased]

Everything below is the content of the planned 1.0.0, the first release. Nothing has been tagged yet,
and the project was called Agent Arena until this release.

### Added

- **Six architectures on one harness.** `single` (the control), `plan-execute`,
  `orchestrator-workers`, `plan-execute-verify`, `propose-select` and `gated-execute`, all built on one
  phase runner with the same system prompt, tool surface and budgets, so a design wins on its
  structure. `propose-select` is the old `debate-select`, renamed because its three proposers never
  saw one another; recorded runs under the old id are mapped to the new one and never pooled with new
  runs. `gated-execute` reviews each state-changing tool call before it runs.
- **25 tasks.** Nine tool-use tasks (airline, e-commerce and support, easy to hard), ten **expert-tier**
  tool-use tasks (long runs against a back office with records that arrive mid-run, hidden traps and
  seeded variants, scored from an oracle), and six research tasks.
- **A frozen research corpus** (`fixtures/corpus`). Research tasks no longer touch the web or replay
  recorded searches: they search a fixed snapshot of public documents with a local BM25 index, and a
  citation only counts if its quote is in a passage the agent was actually shown. `scripts/build-corpus.ts`
  is the only code that uses the network.
- **Fidelity and integrity checks.** Every run record carries `integrity: { ok, checks[] }`: harness
  checks (no failed API call, MCP servers connected, no tool the session was not meant to have, structured
  output delivered, no silently degraded phase) and per-architecture checks that read the trace to prove the
  design ran. A run that fails any of them is never ranked, and the site has a page for how often each held.
- **Paired, task-clustered statistics.** Comparisons are paired by task and the bootstrap resamples
  tasks, not runs, with Holm correction per family of comparisons, equivalence tests so that "no
  difference" is a finding rather than the absence of one, a minimum number of tasks before any
  verdict, and a "Scaffold or Scale?" analysis that
  contrasts each architecture on a smaller model with the plain single agent on the next model up. A contrast with no usable interval says so instead of printing one. See
  `docs/STATISTICS.md`.
- **The Act 1 post-mortem** (`docs/POSTMORTEM.md`): how the first run set's tie came from four
  architectures that never ran as designed, with the root causes, the fixes and commands that
  re-derive every count. The run set's 90 traces are committed as its evidence.
- **Pre-registration** of the first campaign (`docs/PREREGISTRATION.md`), the frozen description of what is
  measured and how it is analysed.
- **A command line**, `scaffoldbench` (`npm run bench -- <command>` in the repository): `run` with a
  plan and worst-case cost shown before it starts, a live task x architecture grid, per-run and total
  cost ceilings, `--resume`, a lock against two sessions on one run set, and `--update-latest`;
  `report` for the terminal and Markdown, with `--strict` as a gate for CI; `doctor`; `tasks`;
  `strategies`.
- **A static site** (Next.js export, deployed to GitHub Pages) with the leaderboard, per-cell matrix,
  Pareto frontier, health page, methodology, architecture designs, task pages, replayable traces and the
  post-mortem. It reads the same analysis as the CLI. An optional server mode adds a live demo that runs
  one task on a visitor's own API key; see `SECURITY.md`.
- **CI**: typecheck and tests on Node 22 and 24 with no credentials, a hardened benchmark workflow, and
  the Pages workflow.
- Community files: contributing guide, code of conduct, security policy, citation metadata, issue and
  pull request templates.

### Fixed

Harness bugs that the first run set's post-mortem found. That run set scored five architectures between
0.980 and 1.000 although four of them never ran as designed; it is kept in `results/` as evidence, and
reported as ranked but unverified.

- The tool surface leaked: every run also loaded the host's own agent tools, whose set depended on the
  machine. Tools are now pinned alongside the allowlist.
- Exact-key replay of recorded searches missed nearly every query. Replaced by the frozen corpus.
- A turn that hit its cap or budget discarded the whole run. The last assistant text is now recovered, and
  a truncated run is a valid data point.
- Resolving the repository root broke under the site's bundler.
- The live demo could fall back to the operator's credentials; a visitor's run now authenticates only as the
  visitor.
- The CLI rejected a working login-based credential setup; it now reports which account will be billed.

### Changed

- Renamed from Agent Arena: the npm scope is `@scaffoldbench/*`, the root script is `bench`, the CLI is
  `scaffoldbench`, and environment variables are `SCAFFOLDBENCH_*`. There are no fallbacks to the old names.
- The five development run sets were removed from `results/`; the first full run set stays as post-mortem
  evidence.
- The README leads with the two-act story and a results placeholder for the pre-registered run set.
  The legacy results prose is gone, and the list of defects found by live runs moved to
  `docs/ARCHITECTURE.md`.
