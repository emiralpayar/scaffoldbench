# Adding a task

Tasks own both their environment and their scorer, so a new task can be added without touching the
runner, the strategies or the site. There are two kinds, and they are added in different ways.

- [A new sandbox world](#part-1--a-new-sandbox-world) — deterministic, no model in the grading loop.
- [A new research task](#part-2--a-new-research-task) — rubric-graded plus a deterministic citation audit.
- [The tests you must write](#the-tests-you-must-write) — golden path, violation, untouched world.

Before you start, read the contracts in
[`packages/core/src/types.ts`](../packages/core/src/types.ts). Everything below implements them.

---

## Part 1 — a new sandbox world

A world is four files under `packages/tasks/src/worlds/<name>/`:

```
world.ts   the state, the seed, the domain constants, pure helpers
tools.ts   JournaledToolSpec[] closing over one world instance
tasks.ts   defineToolUseTask(...) x 3 — easy, medium, hard
index.ts   export * from './world'; './tools'; './tasks';
```

### 1. `world.ts` — the state

Plain data. Two rules that are not negotiable, because scoring depends on them:

- **Money is integer cents. Dates are `YYYY-MM-DD`,** compared against a `world.today` field rather
  than the wall clock. A world that consults `Date.now()` produces a task whose correct answer
  changes overnight.
- **Every run starts from an identical world.** Define one `SEED` constant and clone it:

```ts
// packages/tasks/src/worlds/airline/world.ts
const SEED: AirlineWorld = {
  today: '2026-07-28',
  flights: [ /* … */ ],
  reservations: [ /* … */ ],
  passengers: [ /* … */ ],
  ledger: [],
};

export function createAirlineWorld(): AirlineWorld {
  return structuredClone(SEED);
}
```

Export whatever pure helpers the tools and the assertions both need — `findReservation`,
`baggageFeeCents`, `freeCheckedBags` — so the scorer computes the expected value from the same
function the world uses, instead of hard-coding a number that will drift.

Seed the world so that the *obvious* action is not always the correct one. `airline-medium` works
because the earliest departure is sold out in the requested cabin and the one before that is
cancelled, so an agent that reads only the departure times gets it wrong.

### 2. `tools.ts` — the toolset

`createTools(world)` returns `JournaledToolSpec[]`. The journaling wrapper
([`core/src/tools.ts`](../packages/core/src/tools.ts)) records every call automatically; you write
plain handlers.

```ts
// packages/tasks/src/worlds/airline/tools.ts
export function createAirlineTools(world: AirlineWorld): JournaledToolSpec[] {
  return [
    {
      name: 'get_baggage_rules',
      description:
        'Read the checked-baggage allowance table and the fee schedule for bags beyond the allowance.',
      readOnly: true,
      schema: {},
      handler: () => { /* … render the rule table … */ },
    },
    {
      name: 'add_baggage',
      description: 'Add checked bags to a reservation. Charging for them is a separate step.',
      schema: {
        reservationId: z.string(),
        additionalBags: z.number().int().min(1).describe('How many bags to add'),
      },
      handler: ({ reservationId, additionalBags }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        if (reservation.status !== 'confirmed') {
          return error(`reservation ${reservationId} is ${reservation.status}, bags cannot be added`);
        }
        // …
        reservation.checkedBags = after;
        return `Reservation ${reservationId}: checked bags ${before} -> ${after}. No fee has been charged.`;
      },
    },
  ];
}
```

Five things to get right:

1. **`readOnly: true` on every tool that cannot mutate state.** This is not cosmetic. It is how
   `propose-select` decides which tools its three parallel proposers may hold, and how
   `plan-execute-verify` restricts its verifier. Mark a mutating tool read-only and you will let
   three agents trample the same world.
2. **Return an error reply, never throw.** `{ text: 'Error: …', isError: true }`. Errors are
   journaled with `ok: false`; a thrown handler would be caught by the wrapper anyway, but a
   deliberate message tells the agent what to do next.
3. **Never compute the answer for the agent.** `add_baggage` explicitly says *"No fee has been
   charged"*. If a tool returns the number the task is about, you have measured tool design, not
   the harness.
4. **Split reads from writes.** "Consult the rules before acting" is only checkable if consulting
   is a separate tool call that lands in the journal.
5. **Say exactly what changed** in the reply of a mutating tool, so a verifier phase has something
   to check against.

### 3. `tasks.ts` — the tasks

```ts
// packages/tasks/src/worlds/airline/tasks.ts
export const airlineEasyTask: Task = defineToolUseTask<AirlineWorld>({
  id: 'airline-easy',
  world: 'airline',
  title: 'Add checked bags and collect the right fee',
  difficulty: 'easy',
  tags: ['airline', 'baggage', 'fees', 'multi-hop-lookup'],
  maxTurns: 14,
  prompt: [
    'Rosa Mendel is flying to Seattle on reservation R1042 and wants to add two more checked bags.',
    'Update her reservation and collect exactly what she owes for them.',
  ].join(' '),
  policy: [
    'Checked baggage:',
    '- The free checked-bag allowance comes from two places at once: the cabin on the reservation and',
    "  the passenger's frequent-flyer tier. Look up both; neither one alone gives you the allowance.",
    '- Read the baggage rules before charging any baggage fee. Charging from memory is a violation even',
    '  if the amount happens to be right.',
    // …
  ].join('\n'),
  instructions: AIRLINE_INSTRUCTIONS,
  createWorld: createAirlineWorld,
  createTools: createAirlineTools,
  assertions: [ /* below */ ],
  forbidden: [ /* below */ ],
});
```

`prompt` is the user's request, handed to the agent verbatim. `policy` is binding domain rules,
injected into the system prompt for *every* strategy by `buildSystemPrompt`. Keep the rules in
`policy` and the request in `prompt`: a rule smuggled into the prompt gets restated by some
architectures and paraphrased by others.

**Assertions** are the weighted breakdown, evaluated against the final world and the journal.
Return `true`/`false`, or a number in 0..1 for partial credit:

```ts
{
  id: 'baggage-fee-exact',
  label: 'Exactly one baggage fee, for the bags beyond the free allowance',
  weight: 4,
  check: (world) => {
    const reservation = reservationOrThrow(world, EASY_RESERVATION);
    const entry = onlyEntry(world, EASY_RESERVATION);
    if (!entry) return false;
    return (
      entry.kind === 'fee' &&
      entry.category === 'baggage_fee' &&
      entry.amountCents === baggageFeeCents(chargeableBags(world, reservation))
    );
  },
  detail: (world) => { /* string shown in the run detail view */ },
}
```

Note that the expected amount is *computed* from the same helpers the world uses. Prefer that over
a literal, so retuning a fee constant does not silently invalidate the task.

**Forbidden rules** are multiplicative penalties. Default `multiplier: 0` — a hard fail that cannot
be bought off with credit elsewhere.

```ts
{
  id: 'baggage-fee-without-rules',
  label: 'Charged a baggage fee without reading the baggage rules',
  detail: 'get_baggage_rules must succeed before charge_fee.',
  violated: (_world, journal) =>
    actedBeforeConsulting(journal, EASY_RESERVATION, 'charge_fee', 'get_baggage_rules'),
}
```

Ordering rules are read off the **journal**, because "was the rule consulted" leaves no trace in
the final state. Final-state rules are read off the **world**. Both are available to every check.

Give every task a stray-mutation rule. The world holds several records and each task names one;
anything else the agent touched is collateral damage, whatever it got right:

```ts
function strayMutationRule<W extends AirlineWorld>(ownId: string): ForbiddenSpec<W> {
  return {
    id: 'stray-mutation',
    label: 'Changed a reservation other than the one in the request',
    kind: 'unsafe_action',
    violated: (world) => {
      if (world.ledger.some((entry) => entry.reservationId !== ownId)) return true;
      const seed = createAirlineWorld();
      return world.reservations.some((reservation) => {
        if (reservation.id === ownId) return false;
        return JSON.stringify(findReservation(seed, reservation.id)) !== JSON.stringify(reservation);
      });
    },
  };
}
```

### 4. Register it

Export the trio from your `tasks.ts`, re-export it from the world's `index.ts`, then add it to
[`packages/tasks/src/registry.ts`](../packages/tasks/src/registry.ts):

```ts
// packages/tasks/src/worlds/<name>/tasks.ts
export const myWorldTasks: Task[] = [myWorldEasyTask, myWorldMediumTask, myWorldHardTask];

// packages/tasks/src/registry.ts
export const ALL_TASKS: Task[] = [
  ...airlineTasks,
  ...ecommerceTasks,
  ...supportTasks,
  ...myWorldTasks,   // <- here
  ...researchTasks,
];
```

`ALL_TASKS` order is render order, and `getTasks` never reorders — selection filters `ALL_TASKS`
rather than following the order the flags were typed, so `--tasks support,airline` and
`--tasks airline,support` produce identical, line-comparable reports.

Registration is all it takes. `TASK_WORLDS` is derived from `ALL_TASKS`, so your world name
immediately becomes a valid selector, alongside the task ids, the two categories and globs:

```bash
npm run arena -- tasks                       # your three tasks are listed
npm run arena -- run --tasks my-world        # the whole world
npm run arena -- run --tasks 'my-world-*'    # same, by glob
```

---

## Part 2 — a new research task

Research tasks need no new tools: they all share `search` and `fetch_page`. A task is one call to
`defineResearchTask` in
[`packages/tasks/src/research/tasks.ts`](../packages/tasks/src/research/tasks.ts), added to the
`researchTasks` array at the bottom of that file — the registry already spreads it.

```ts
const httpRedirects = defineResearchTask({
  id: 'research-http-redirects',
  title: 'HTTP 301 vs 308',
  question:
    'What is the difference between HTTP status codes 301 and 308? Explain what each one means, ' +
    'how a client is expected to treat the request method and body when following each, whether ' +
    'each is cacheable, and where each is specified.',
  difficulty: 'easy',
  tags: ['http', 'specifications', 'comparison'],
  maxTurns: 14,
  requiredSources: ['rfc-editor.org', 'developer.mozilla.org'],
  rubric: [
    {
      id: 'method-preserved-308',
      claim:
        'States that 308 requires the client to reuse the original request method and body when following the redirect.',
      weight: 1.5,
    },
    // …
  ],
});
```

Four constraints:

- **The answer must not drift.** Specifications, standards, long-settled semantics. Anything that
  moves with a release cycle — prices, benchmarks, "current best practice" — makes a task that
  stops measuring the harness the moment it changes.
- **Every rubric item is a flat, checkable statement,** phrased so a grader decides whether the
  answer *says* it, not whether the answer is *good*. Quality judgements are where judges disagree.
- **`requiredSources` are domains a thorough answer should have opened.** They become a
  source-coverage item worth 20% of the rubric weight, scored from the URLs actually fetched.
- **`allowedDomains`, if set, makes `fetch_page` refuse everything else.** Use it when a task
  should be confined to primary sources.

Weight the items that separate a real answer from a plausible one. In the OWASP-vs-NIST task the
heaviest item (weight 2) is `names-the-conflict` — *explicitly says the two sources disagree* —
because presenting a single confident recommendation is exactly the failure the task exists to
detect.

### Record the fixtures

A new research task has no recordings, and in `replay` mode its searches will all miss. Record once
and commit:

```bash
npm run arena -- run --strategies single --tasks research-my-task --repeats 1 \
  --model claude-sonnet-5 --record
git add fixtures && git commit -m "Record fixtures for research-my-task"
```

Then verify the task runs offline before you rely on it (`--replay` is the default, but say it):

```bash
npm run arena -- run --strategies single --tasks research-my-task --repeats 1 \
  --model claude-sonnet-5 --replay
```

Fixtures are keyed on the normalized request text, so a strategy that phrases a query differently
will still miss. Record with a couple of different strategies if you want broad coverage — or
accept the misses, since the replay-mode error message tells the agent it is offline and to
continue with what it has, which is itself a legitimate thing to measure.

---

## The tests you must write

Every task needs three tests. They are what make a scorer trustworthy: a rubric nobody has
exercised is a rubric that scores everything zero, or everything one, and you will not find out
until you have paid for a sweep.

Tests live in `packages/tasks/test/<world>.test.ts` and run without a network, a key, or the SDK.

### The driver

Drive the tool handlers exactly as the journaling MCP wrapper would. The world the driver mutates
is the same object the scorer is handed, which is what makes these tests end-to-end:

```ts
// packages/tasks/test/airline.test.ts
function drive(): Driver {
  const world = createAirlineWorld();
  const journal: ToolCall[] = [];
  const byName = new Map(createAirlineTools(world).map((spec) => [spec.name, spec] as const));

  async function invoke(name: string, args: Record<string, unknown>) {
    const spec = byName.get(name);
    if (!spec) throw new Error(`unknown tool in test: ${name}`);
    const reply = await spec.handler(args);
    const text = typeof reply === 'string' ? reply : reply.text;
    const ok = typeof reply === 'string' ? true : reply.isError !== true;
    journal.push({ name, args, tMs: journal.length, ok, result: text });
    return { text, ok };
  }
  // … .call() throws on an unexpected error, .expectError() asserts one …
}

function scoreInput(driver: Driver): ScoreInput {
  return {
    env: { mcpServers: {}, allowedTools: [], readOnlyTools: [], state: driver.world, journal: driver.journal },
    outcome: { finalText: '', subagentCount: 0, phases: [] },
    trace: [],
    deps: {
      judge: async () => {
        throw new Error('tool-use tasks must not call the judge');
      },
      judgeSamples: 1,
    },
  };
}
```

That throwing judge is deliberate. It asserts, on every tool-use test, that nothing in the
deterministic path has quietly acquired a dependency on a model.

### 1. Golden path — scores exactly 1

```ts
it('scores 1 on the golden path', async () => {
  const d = await goldenPath();
  const score = await airlineEasyTask.score(scoreInput(d));

  expect(findReservation(d.world, 'R1042')?.checkedBags).toBe(3);
  expect(d.world.ledger).toHaveLength(1);
  expect(score.penalties).toEqual([]);
  expect(score.score).toBe(1);
  expect(score.passed).toBe(true);
  expect(score.failureMode).toBe('none');
});
```

Assert the world *and* the score. A test that only checks `score === 1` will still pass if two
assertions are broken in compensating directions.

### 2. Violation — the rule fires and hard-fails

One test per forbidden rule. Assert the specific penalty id, the zero, and the failure mode:

```ts
it('hard-fails when a fee is charged without consulting the baggage rules', async () => {
  const d = drive();
  await d.call('get_reservation', { reservationId: 'R1042' });
  await d.call('add_baggage', { reservationId: 'R1042', additionalBags: 2 });
  await d.call('charge_fee', { reservationId: 'R1042', category: 'baggage_fee', amountCents: 9000 });

  const score = await airlineEasyTask.score(scoreInput(d));
  expect(penaltyIds(score)).toContain('baggage-fee-without-rules');
  expect(score.score).toBe(0);
  expect(score.failureMode).toBe('policy_violation');
});
```

Also test partial credit — the case where nothing is *forbidden* but something is *wrong* — so you
know the breakdown discriminates rather than collapsing to 0 or 1:

```ts
it('withholds credit when the tier allowance is ignored and the fee is too high', async () => {
  // …
  expect(score.penalties).toEqual([]);
  expect(score.breakdown.find((item) => item.id === 'baggage-updated')?.earned).toBe(1);
  expect(score.breakdown.find((item) => item.id === 'baggage-fee-exact')?.earned).toBe(0);
  expect(score.score).toBeLessThan(1);
});
```

### 3. Untouched world — scores exactly 0

The agent that does nothing must score nothing. This catches an assertion that is accidentally
satisfied by the seed:

```ts
it('scores 0 on an untouched world', async () => {
  const score = await airlineEasyTask.score(scoreInput(drive()));
  expect(score.score).toBe(0);
  expect(score.passed).toBe(false);
});
```

There is a second sense of "untouched" worth testing once per world — that the read-only tools
really are read-only:

```ts
it('leaves the world untouched when only read tools are called', async () => {
  const d = drive();
  await d.call('get_reservation', { reservationId: 'R1042' });
  await d.call('get_baggage_rules', {});
  // … every read tool …
  expect(d.world).toEqual(createAirlineWorld());
});
```

### Also worth testing

- **Seed independence** — two `createWorld()` calls return unshared objects.
- **`readOnly` flags** — every read tool marked, no mutating tool marked, and the count matches.
- **Tool error handling** — unknown ids and impossible operations report errors instead of
  throwing, and the world is unchanged afterwards.
- **Task metadata** — ids, difficulties, a non-trivial `policy`, a sane `maxTurns`.
- **Environment shape** — `readOnlyTools` is a strict subset of `allowedTools` and the qualified
  names are what you expect.

For research tasks, use a fake `Judge` returning canned verdicts, plus a `fetchImpl` stub for the
web tools. See the fixtures, rubric-scoring, citation-integrity and source-coverage suites in
[`packages/tasks/test/research.test.ts`](../packages/tasks/test/research.test.ts).

---

## Before you open the PR

```bash
npm run check         # typecheck + all tests
npm run check:wiring  # optional: asserts your MCP tools actually register with a real session
```

Then run your task once for real, cheaply, and read the trace:

```bash
npm run arena -- run --strategies single --tasks my-new-task --repeats 1 --model claude-sonnet-5
npm run dev:web
```

If `single` scores 1 on the first attempt, the task is probably too easy to separate five
architectures. If every strategy scores 0, check that the policy is discoverable from the tools
rather than only from your own head.
