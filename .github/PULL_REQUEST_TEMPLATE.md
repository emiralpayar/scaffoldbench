<!-- Thanks for the pull request. CONTRIBUTING.md says what a PR has to show. -->

## What and why

<!-- What changes, and what it fixes or enables. Link the issue it closes. -->

## What this touches

- [ ] Site, CLI, docs or tooling only
- [ ] A new or changed task (`packages/tasks`)
- [ ] A new or changed architecture (`packages/strategies`)
- [ ] Anything that changes what a run measures (scoring, analysis, system prompt, an existing task or architecture)

<!-- The last one needs an issue first: see "Frozen measurement code" in CONTRIBUTING.md. -->

## Evidence

- [ ] `npm run check` passes
- [ ] `npm run build:web` passes (if `apps/web` or anything it imports changed)
- [ ] New behaviour has tests; a bug fix has a test that failed before it
- [ ] Task: reference solution scores 1, untouched world scores 0, every trap is caught, and I read a real single-agent trace (`docs/ADDING-A-TASK.md`)
- [ ] Architecture: fidelity checks, and a `realSeam` case where an ordinary run passes them and a degraded run fails them
- [ ] Site change: screenshots of the page, light and dark, at desktop and phone width
- [ ] I did not edit anything under `results/` by hand, and no secret or `.env` is committed

<!-- If you ran paid benchmark runs, say what they cost and paste the report command and output. -->
