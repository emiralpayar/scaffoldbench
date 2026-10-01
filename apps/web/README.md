# ScaffoldBench site

The Next.js site that renders a stored run set: the landing story, results
model by model, score against cost, the per-run matrix, run and task pages.
Every figure is read from `results/` at build time, and nothing in the
static build calls an API.

```sh
npm run dev:web                    # http://localhost:3210, the published run set
ARENA_DEMO=1 npm run dev:web       # synthetic data, after `npm run demo:data`
npm run build:web                  # static export to apps/web/out
```

## Build modes

**Static (the default).** `next build` writes plain HTML to `apps/web/out`.
There is no server, no API route and nothing that asks for a key. This is
what `.github/workflows/pages.yml` deploys to GitHub Pages.

**Server (`NEXT_PUBLIC_ARENA_LIVE=1`).** A Node server that also serves
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
| `ARENA_RESULTS_DIR` | Read run sets from another directory. A path that does not exist renders the empty state. |
| `ARENA_DEMO=1` | Read the synthetic set in `demo-data/`. Every page that shows a number then carries a synthetic-data banner. |
| `ARENA_REQUIRE_REAL_DATA=1` | Fail the build instead of rendering a synthetic set. The Pages workflow sets it. |
| `NEXT_PUBLIC_ARENA_LIVE=1` | Server mode, above. |
| `ARENA_TRUST_PROXY=1` | Server mode only: rate-limit by `X-Forwarded-For`, for a host behind a proxy that sets it. |

## Where things live

- `lib/` is pure and safe in client components (`format`, `analysis`,
  `chartData`, `architectures`, `glyphs`). `lib/server/` is the only code
  that touches the filesystem.
- `components/charts/` draws every chart as server-rendered SVG, each with a
  table of its numbers.
- `app/globals.css` holds the colour, type, space and motion tokens for both
  themes; `test/tokens.test.ts` checks their contrast and the architecture
  palette's separation.
