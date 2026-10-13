# ScaffoldBench site

The Next.js site that renders a stored run set: the landing story, results
model by model, score against cost, the per-run matrix, task, run and
architecture pages, harness health, the methodology and the post-mortem of
the first run set. Every figure is read from `results/` at build time, and
nothing in the static build calls an API.

```sh
npm run dev:web                    # http://localhost:3210, the published run set
SCAFFOLDBENCH_DEMO=1 npm run dev:web       # synthetic data, after `npm run demo:data`
npm run build:web                  # static export to apps/web/out
```

## Pages

| Route | What it answers |
|---|---|
| `/` | The result: the headline and its numbers, a race of every architecture on one task, the result chart, the pre-registration scorecard (H1–H6), the exploratory observation, featured traces, then Act 1. |
| `/results/`, `/results/<model>/`, `/results/scale/` | Who ranks where on a model, with intervals and ties; the cross-model "scaffold or scale" view. |
| `/pareto/` | Score against cost. |
| `/matrix/`, `/matrix/<model>/` | Every run as a square, and who fell into which declared trap. |
| `/tasks/<task>/`, `/tasks/<task>/<model>/` | A task: its pre-registered hypothesis, every run, the traps and the graded items each design missed. |
| `/runs/<run>/` | One run, explored or replayed call by call. |
| `/strategies/`, `/strategies/<id>/` | A design drawn as the calls it makes, what it costs by stage, which checks held. |
| `/health/` | Every integrity check and the runs excluded for failing one. |
| `/methodology/` | How a run is scored, how it proves it ran, how runs become claims, and the limits. |
| `/postmortem/` | The first run set, retracted: what its traces showed. |
| `/live/` | Recorded runs replayed; with `NEXT_PUBLIC_SCAFFOLDBENCH_LIVE=1`, a run on a visitor's own key. |

Per-model pages are static pages of their own, so a model is a link and the
switch needs no script.

## Build modes

**Static (the default).** `next build` writes plain HTML to `apps/web/out`.
There is no server, no API route and nothing that asks for a key. This is
what `.github/workflows/pages.yml` deploys to GitHub Pages.

**Server (`NEXT_PUBLIC_SCAFFOLDBENCH_LIVE=1`).** A Node server that also serves
`/api/live`, which runs one tool-use task on a visitor's own API key and
streams the trace. It spawns the Agent SDK's subprocess, so it needs a
long-lived Node host, not a serverless function. The rules that keep it safe
(credential isolation, no judge, key pre-check, caps, rate limit) are in
`lib/server/live.ts` and tested in `test/live.test.ts`.

## Environment

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_BASE_PATH` | Sub-path the export is served under, e.g. `/scaffoldbench` for a GitHub Pages project site. |
| `NEXT_PUBLIC_SITE_URL` | Absolute URL including the base path, for Open Graph URLs, the sitemap, robots.txt and the social card. |
| `NEXT_PUBLIC_REPO_URL` | Repository URL. When set, trust claims and evidence link to the files they name. |
| `SCAFFOLDBENCH_RESULTS_DIR` | Read run sets from another directory. A path that does not exist renders the empty state. |
| `SCAFFOLDBENCH_DEMO=1` | Read the synthetic set in `demo-data/`. Every page that shows a number then carries a synthetic-data banner. |
| `SCAFFOLDBENCH_REQUIRE_REAL_DATA=1` | Fail the build instead of rendering a synthetic set. The Pages workflow sets it. |
| `NEXT_PUBLIC_SCAFFOLDBENCH_LIVE=1` | Server mode, above. |
| `SCAFFOLDBENCH_TRUST_PROXY=1` | Server mode only: rate-limit by `X-Forwarded-For`, for a host behind a proxy that sets it. |

## Where things live

- `lib/` is pure and safe in client components (`format`, `analysis`,
  `chartData`, `architectures`, `glyphs`). `lib/server/` is the only code
  that touches the filesystem.
- `components/charts/` draws every chart as server-rendered SVG, each with a
  table of its numbers.
- `lib/designs.ts` describes what each architecture is made of (its stages,
  what each call is shown, its fidelity checks), and a test holds it to the
  glyph geometry in `lib/glyphs.ts`.
- `lib/scorecard.ts` computes the landing page's headline numbers and the H1–H6
  verdicts from the analysis; `test/scorecard.test.ts` holds them to the
  committed flagship run set.
- `lib/featuredRuns.ts` lists the runs whose traces are committed (see the
  `.gitignore` exception) and what to look for in each. A run without a
  committed trace renders its record and links these instead.
- `lib/postmortem.ts` holds the first run set's numbers (`ACT_ONE`).
  `test/postmortem.test.ts` re-derives every one from the committed run
  records, and from the traces whenever a checkout has them.
- `app/globals.css` holds the colour, type, space and motion tokens for both
  themes; `test/tokens.test.ts` checks their contrast and the architecture
  palette's separation.
- `lib/pageMetadata.ts` builds a page's title, Open Graph and Twitter
  blocks and canonical link from one title, description and route. Every
  page uses it: set only a `title` and Next drops the layout's blocks, so the
  page would unfurl as the home page. The post-mortem has a social card of its
  own (`app/postmortem/og.png`); the rest share `app/og.png`.
- `components/Link.tsx` is `next/link` with prefetching off. A production build
  otherwise fetches every page a link scrolls past: opening the matrix
  fetched some 8 MB of pages (uncompressed) that nobody opened. Import it, not
  `next/link`.
