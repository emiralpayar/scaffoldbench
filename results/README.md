# results/

Benchmark output lives here. Each run set is a directory:

```
results/
  latest.json                 { "runSetId": "..." } — what the site renders by default
  <runSetId>/
    manifest.json             config, git sha, model, totals, duration
    catalog.json              strategy and task metadata as of that run
    runs/<runId>.json         one RunRecord per strategy x task x repeat
    traces/<runId>.jsonl      one normalized TraceEvent per line
    REPORT.md                 written by `arena report --markdown`
```

`runs/` and the manifests are committed so results are reviewable in a diff and
citable by commit. `traces/` is gitignored by default — traces are large, and
the run summary already carries everything the leaderboard needs. Commit a
trace deliberately when it illustrates something worth pointing at.

This directory is empty until you run a benchmark:

```bash
npm run arena -- run --strategies single,plan-execute --tasks airline-easy --repeats 1
```

The site renders an empty state until then. It never ships placeholder numbers.
