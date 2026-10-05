# Security policy

## Reporting a vulnerability

Please report it privately through GitHub security advisories:
**[Report a vulnerability](https://github.com/emiralpayar/scaffoldbench/security/advisories/new)**
(the repository's Security tab, then "Report a vulnerability"). Do not open a public issue or pull
request for it, and do not post it anywhere else until it is fixed.

Say what you found, how to reproduce it and what an attacker gains. A proof of concept against your
own key or your own machine is plenty; please do not test against anyone else's. I aim to
acknowledge a report within seven days, and to say what I plan to do about it soon after. This is a
one-person open-source project, so those are targets and not guarantees.

## What is in scope

ScaffoldBench is a benchmark you run yourself. The parts where a mistake could hurt someone:

- **The optional live server.** Built with `NEXT_PUBLIC_SCAFFOLDBENCH_LIVE=1`, the site serves
  `/api/live`, which runs one task on a **visitor's own Anthropic API key** and streams the trace
  back. That makes it the most sensitive part of the project. Its design rules are:
  a visitor's run authenticates only as the visitor (every other credential source, including the
  operator's Claude Code login, is removed from the subprocess); no judge runs, so no grading call
  can fall back to the operator's credentials; the key is read from the request body, never
  stored or written anywhere, and everything streamed back passes through secret redaction; every
  run is bounded in cost, time, concurrency and rate. Anything that breaks one of those (a key leaking
  into a response, a log or a trace; a run billed to the operator; a way around the caps or the rate
  limit) is a vulnerability. The rules live in `apps/web/lib/server/live.ts`.
- **The sandbox guard.** During a run the agent gets only the task's own tools: the built-in shell,
  file and web tools are denied, and a hook checks every call against an allowlist. A way for an
  agent, or for text a task puts in front of it, to run a built-in tool, call a tool outside the
  allowlist, or touch the host through one the task did offer, is in scope.
- **Credential handling in the CLI and the harness.** Secrets reaching a manifest, a trace, a run
  record, a report or the terminal; or an unintended account being billed.
- **The workflows in `.github/workflows`,** if they can be made to run untrusted code with a secret.

The default site is a static export. It has no server, no API route and no place to enter a key, so
it holds nothing to steal.

## What is not

- A wrong or surprising benchmark result, a flawed task, or a bug in the statistics. Those matter, but
  they are ordinary issues: open one.
- Findings that need an attacker to already control your machine, your `.env` or your results
  directory.
- Denial of service against a live server you operate without its caps in place.

## Running the live server

If you operate one, keep it behind a proxy that you control. Set `SCAFFOLDBENCH_TRUST_PROXY=1` only
when that proxy sets `X-Forwarded-For` itself; without it, all visitors share one rate-limit bucket.
Do not give the process a credential you would mind a visitor's run touching, and use a host that
can run a long-lived Node process.

## Supported versions

The latest commit on `main` is the only supported version. There are no backports.

## Known advisories

`npm audit` reports one advisory family that is deliberately left open: PostCSS ≤ 8.5.22, which
Next.js 15 bundles for its own CSS build step (GHSA: XSS via an unescaped `</style>` in CSS
stringify, and a file-read issue). Next.js runs it at build time over this repository's own
stylesheets, which contain no untrusted input, and the published site is static HTML. The fix
requires Next.js 16, a major upgrade that will be made on its own.
