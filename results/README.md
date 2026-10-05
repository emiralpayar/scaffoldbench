# results/

Recorded benchmark output. Everything under a run set's directory is data a run wrote. Nothing in
here is edited by hand, so a number on the site can always be traced to a file in a commit.

## Layout

```
results/
  latest.json                 { "runSetId": "..." }  what the site and `report` show by default
  <runSetId>/
    manifest.json             the configuration, provenance (commit, SDK, Node), status and totals
    catalog.json              strategy and task metadata as of that run
    runs/<runId>.json         one RunRecord per model x strategy x task x repeat cell
    traces/<runId>.jsonl      one normalized TraceEvent per line, for the trace viewer
    REPORT.md                 written by `npm run bench -- report <runSetId> --markdown`
```

- **`manifest.json`** is rewritten after every run, so a killed session leaves a readable manifest
  with `status: "running"`. `scaffoldbench run --resume <runSetId>` continues from it.
- **`catalog.json`** freezes what the strategies and tasks were called and described as when the
  run set was recorded, so the site can still explain a run set after the code has moved on.
- **`runs/`** holds everything the leaderboard, the analysis and the integrity checks need. The run
  summaries and manifests are committed, so results are reviewable in a diff and citable by commit.
- **`traces/`** is gitignored by default: traces are large and the run summary carries what the
  numbers need. Commit a trace deliberately when it illustrates something worth pointing at. The
  legacy run set below is the exception: all 90 of its traces are committed, because they are the
  evidence for [`docs/POSTMORTEM.md`](../docs/POSTMORTEM.md).

Run set ids look like `2026-07-25T20-18-35Z-3fs5`: the UTC start time and four random characters.
A run id names the cell it measured, so a file name says what is inside it.

## latest.json

`latest.json` is the pointer the static site follows. A run **never** moves it unless it was started
with `--update-latest`; otherwise the CLI prints that the pointer was left alone. A trial run, a
dry run or a partial run therefore cannot change what the website shows.

## What is committed

| Run set | What it is |
| :--- | :--- |
| `2026-07-25T20-18-35Z-3fs5` | The first full run set: 5 architectures x 9 tasks x 2 repeats on one model (90 runs, $9.11), recorded before the fidelity and integrity checks existed. Its five architectures scored between 0.980 and 1.000, and the traces showed four of them had not run as designed. It is kept, with all 90 traces, as the evidence for [`docs/POSTMORTEM.md`](../docs/POSTMORTEM.md) and the site's post-mortem page, not as a result: `report` renders it as ranked but unverified. |

Run sets from the pre-registered campaign (see [`docs/PREREGISTRATION.md`](../docs/PREREGISTRATION.md))
are committed here once they have finished, and `latest.json` is moved to the one the site should
show. Until a measured, verified run set is committed, the site shows the legacy one above and says
so.

## Producing a run set

```bash
npm run bench -- run --strategies single,plan-execute --tasks airline-easy --repeats 1 --dry-run   # the plan, for free
npm run bench -- run --strategies single,plan-execute --tasks airline-easy --repeats 1             # spends money
npm run bench -- report <runSetId>
```

Add `--update-latest` to point `latest.json` at the new run set, and `--results-dir <path>` (or
`SCAFFOLDBENCH_RESULTS_DIR`) to write somewhere other than this directory. `npm run demo:data`
writes a clearly marked synthetic run set under `apps/web/demo-data`, never here.
