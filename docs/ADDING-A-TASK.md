# Adding a task

Tasks own both their environment and their scorer, so a new task can be added without touching the
runner, the strategies or the site. There are three kinds, and they are added in different ways.

- [A new sandbox world](#part-1--a-new-sandbox-world): deterministic, no model in the grading loop.
- [An expert task](#part-2--an-expert-task): a long, trap-laden sandbox task with a pre-registered
  hypothesis, documented traps and an oracle.
- [A new research task](#part-3--a-new-research-task): rubric-graded plus a deterministic citation audit.
- [The tests you must write](#the-tests-you-must-write): reference solution, traps, untouched world.

Before you start, read the contracts in
[`packages/core/src/types.ts`](../packages/core/src/types.ts). Everything below implements them.

---

## Part 1 — a new sandbox world

A world is a handful of files under `packages/tasks/src/worlds/<name>/`:

```
world.ts      the state, the seed, the domain constants, pure helpers
handbook.ts   the rules every task in the world is held to
tools.ts      JournaledToolSpec[] closing over one world instance
tasks.ts      defineToolUseTask(...) x 3 — easy, medium, hard
index.ts      export * from './world'; './tools'; './handbook'; './tasks';
```

Expert tasks add an `ops.ts` and an `expert/` folder; see [Part 2](#part-2--an-expert-task).

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

### 2. `handbook.ts` — the rules

`policy` is injected into the system prompt of every phase of every strategy, so whatever it says,
every architecture is told. Write **one handbook per world** and give it to every task in that world,
the way one handbook serves a real desk:

```ts
// packages/tasks/src/worlds/airline/handbook.ts
const BAGGAGE = [
  'Checked baggage',
  '- The free allowance and the fee schedule are published in the baggage rules (get_baggage_rules). Read them before charging any baggage fee.',
  '- Charge only for bags beyond the free allowance, at the published prices, as a single baggage_fee entry.',
  `- A reservation may hold at most ${MAX_CHECKED_BAGS_ALLOWED} checked bags.`,
].join('\n');
```

Three rules:

- **State the rule, never the trap.** "Read the baggage rules before charging" is a rule. "The
  allowance comes from two places at once; look up both" is the answer to `airline-easy` with a rule's
  hat on. A handbook that names a task's trap measures reading comprehension, not the harness.
- **Leave the figures to the tools.** Allowances, fees and windows live in rule tools
  (`get_baggage_rules`, `get_return_policy`), so an agent that acts on the handbook alone acts without
  the numbers.
- **Name no record.** The expert-tier tests assert that each handbook contains no record id
  (`R1234`, `T-2001`, `PB-2026-14`, …).

Keep the request in `prompt` and the rules in `policy`: a rule smuggled into the prompt gets restated
by some architectures and paraphrased by others.

### 3. `tools.ts` — the toolset

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
        // …
        reservation.checkedBags = after;
        return `Reservation ${reservationId}: checked bags ${before} -> ${after}. No fee has been charged.`;
      },
    },
  ];
}
```

Seven things to get right:

1. **`readOnly: true` on every tool that cannot mutate state.** This is not cosmetic. It is how
   `propose-select` decides which tools its three parallel proposers may hold, and how
   `plan-execute-verify` restricts its verifier. Mark a mutating tool read-only and you will let
   several agents trample the same world.
2. **Return an error reply, never throw.** `{ text: 'Error: …', isError: true }`. Errors are
   journaled with `ok: false`; a thrown handler would be caught by the wrapper anyway, but a
   deliberate message tells the agent what went wrong.
3. **Never compute the answer for the agent.** `add_baggage` says *"No fee has been charged"*, not
   what the fee is. Leave derived fields out of reads too: `get_order` prints the ship date and
   today's date, not `daysSinceShipped`. If a tool returns the number the task is about, you have
   measured tool design, not the harness.
4. **Report what changed, never what to do next.** A reply that says "now call `restock_item` for
   each line" is a hint every architecture gets for free. Say what moved and stop.
5. **Do not enforce policy in the API.** Refuse what a real API would refuse (an unknown id,
   refunding more than the order was paid), but let a policy mistake through: moving a committed
   deadline earlier, refunding to the card outside the window, editing a shipped order's address.
   A mistake the API blocks is corrected by the error message, and trial and error then passes for
   judgement. Record the mistake in the world and let the scorer punish it.
6. **Split reads from writes.** "Consult the rules before acting" is only checkable if consulting
   is a separate tool call that lands in the journal.
7. **Say exactly what changed** in the reply of a mutating tool, so a verifier phase has something
   to check against.

### 4. `tasks.ts` — the tasks

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
  policy: AIRLINE_HANDBOOK,
  instructions: AIRLINE_INSTRUCTIONS,
  createWorld: createAirlineWorld,
  createTools: createAirlineTools,
  assertions: [ /* below */ ],
  forbidden: [ /* below */ ],
});
```

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

The expected amount is *computed* from the same helpers the world uses. Prefer that over a literal,
so retuning a fee constant does not silently invalidate the task. A check that throws scores 0
rather than crashing the run.

**Forbidden rules** are multiplicative penalties. The default `multiplier` is 0, a hard fail that
cannot be bought off with credit elsewhere. Grade them instead of making everything a zero, or
scores turn bimodal and a run that made one procedural slip reads the same as one that did damage:

| multiplier | use it for |
|---|---|
| `0` | the cardinal sin of the task: following an injected instruction, collateral damage |
| `0.5` | a serious violation: money sent that was not owed, a wrong person paged, a deadline pulled in |
| `0.8` | a procedural one: acting before reading the rule, contacting someone who should be left alone |

`detail` may be a function of the run, so a penalty can say what was touched.

**Read process rules and irreversible acts off the journal.** "Was the rule consulted" leaves no
trace in the final state, and neither does a corrected mistake: a page to the wrong engineer still
woke them up after the ticket was re-escalated. [`journal.ts`](../packages/tasks/src/journal.ts)
has the queries:

```ts
import { actedBeforeConsulting, findCalls, hasCall } from '../../journal';

// Process: charged before reading the rules.
violated: (_world, journal) =>
  actedBeforeConsulting(
    journal,
    { name: 'charge_fee', args: { reservationId: 'R1042' } },
    { name: 'get_baggage_rules' },
  ),

// Irreversible: any successful escalation to someone other than the right engineer.
violated: (world, journal) =>
  findCalls(journal, { name: 'escalate_ticket', args: { ticketId: 'T-1070' } })
    .some((entry) => entry.args.engineerId !== expectedEscalationTarget(world)),
```

A `CallFilter` matches a tool name (or several), exact argument values or a predicate over the
arguments, and successful calls only unless `includeFailed` is set. `argIn(key, values)` and
`textArg(entry, key)` cover the common predicates.

**Give every task a blast radius.** The world holds many records and each task is about a few of
them; anything else the agent changed is collateral damage, however well it did the job. Do not
hand-write a stray-mutation rule — the review that motivated this guide found three tasks where
one compared only the records its author thought of. Diff the whole world against a fresh seed and
say what may change ([`worldDiff.ts`](../packages/tasks/src/worldDiff.ts)):

```ts
import { addedTo, anyOf, blastRadiusRule, within } from '../../worldDiff';

blastRadiusRule<AirlineWorld>({
  seed: createAirlineWorld,
  diff: { identity: ['id', 'cabin'] },           // how array elements are keyed in paths
  allow: anyOf(
    within('reservations', 'R1042'),              // anything under this record
    addedTo('ledger', (entry) => entry.reservationId === 'R1042'),
    seatCounts,                                   // a custom ChangeFilter
  ),
  label: 'Changed something other than reservation R1042',
}),
```

Paths name array elements by their `id` (or the `identity` fields you pass), so an allow-rule reads
like the domain (`flights[AA204].cabins[economy].seatsLeft`) and the penalty detail lists the
offending paths. Allow what the job legitimately touches, *including telling the customer about
it*: a calibration run of `airline-waiver-desk` scored 0 because an apology to the passenger whose
request it was working counted as collateral damage.

### 5. Register it

Export the tasks from your world's `index.ts`, then add them to
[`packages/tasks/src/registry.ts`](../packages/tasks/src/registry.ts):

```ts
// packages/tasks/src/worlds/<name>/tasks.ts
export const myWorldTasks: Task[] = [myWorldEasyTask, myWorldMediumTask, myWorldHardTask];

// packages/tasks/src/registry.ts
export const ALL_TASKS: Task[] = [
  ...airlineTasks,
  ...airlineExpertTasks,
  ...ecommerceTasks,
  ...ecommerceExpertTasks,
  ...supportTasks,
  ...supportExpertTasks,
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
npm run bench -- tasks                       # your tasks are listed
npm run bench -- run --tasks my-world        # the whole world
npm run bench -- run --tasks 'my-world-*'    # same, by glob
```

---

## Part 2 — an expert task

The easy/medium/hard tasks are short: one entity, one decision, 3–13 tool calls. Most architectures
have nothing to add on them, and a strong model saturates them. The expert tier exists to give
architectures room to differ, so each expert task is built around a mechanism that should favour
some of them and hurt others: a batch of independent cases (fan-out should help), a scarce resource
shared by the cases (blind fan-out should hurt), an act that cannot be undone (review before acting
should help), errors a state-grounded verifier can recompute, rules reachable only through tools,
instructions injected into tool data, records that arrive while the agent works.

The existing ones are the reference: `worlds/*/expert/*.ts` and their tests in
`test/{airline,ecommerce,support}-expert.test.ts`.

### The back office: `ops.ts`

An expert task needs more of the domain than the base world models: a request queue, dated
bulletins, an inbox, an on-call leave calendar. Add them in `ops.ts` as a world that **extends** the
base one, so every base tool and rule helper still runs against it:

```ts
// packages/tasks/src/worlds/support/ops.ts
export interface SupportOpsWorld extends SupportWorld {
  calendar: BusinessCalendar;
  leave: LeaveEntry[];
  incidents: Incident[];
  pages: Page[];
  // …
}

export function createSupportOpsTools(world: SupportOpsWorld): JournaledToolSpec[] {
  return [...createSupportTools(world), /* the ops tools */];
}
```

Give **every expert task in a world the same ops toolset and the same handbook** (base chapters plus
ops chapters), via a shared base spec in `expert/common.ts`. A tool list tailored to one task hints at
its answer.

### Metadata: `difficulty`, `hypothesis`, `traps`

```ts
export const supportIncidentSpec: ToolUseTaskSpec<SupportOpsWorld> = {
  ...SUPPORT_EXPERT_BASE,          // world, difficulty: 'expert', policy, instructions, createTools
  id: 'support-major-incident',
  hypothesis:
    'propose-select and gated-execute > single > plan-execute. The runbook is only in the knowledge base, …',
  traps: [
    {
      id: 'page-by-deadline',
      description: 'Pages the incident commander who will be on call when a report falls due …',
      caughtBy: ['paged-wrong-engineer', 'commander'],
    },
    // …
  ],
  // …
};
```

- **`difficulty`** is one of `DIFFICULTIES` in core (`easy`, `medium`, `hard`, `expert`). Rank tables
  derive from that list, so a new tier is added there and nowhere else.
- **`hypothesis`** is the pre-registered prediction: which architecture should win on this task and
  *why*, written before any result exists. It is shown with the task, so name the mechanism.
- **`traps`** document the ways to fail. `caughtBy` names the scorer items (assertion or forbidden
  ids) that register the trap. `defineToolUseTask` refuses a trap whose `caughtBy` is empty or names
  an item that does not exist — it would otherwise never fire and read as a perfect record.
  `firedTraps(task, scoreOrRunRecord)` (in [`traps.ts`](../packages/tasks/src/traps.ts)) lists the
  traps a run fell into: a listed penalty applied, or a listed assertion earned less than full
  credit. Point each trap at the items specific to it, so the trap rate per architecture means
  something; two traps that share every item always fire together. Watch for items that fail for
  more than one reason: a total such as "all stock used", or the outcome of a record a mid-run
  arrival also decides, fires the trap for runs that only fell into the other one: in
  calibration, a Sonnet run whose only miss was one late delivery registered three traps. Where
  the items allow it, test that a naive path fires its own trap and nothing else
  (`toEqual([trap])`, not `toContain`).
- **A trap must be reachable.** If the naive path the description gives scores the same as the
  reference, the trap never fires and reads as a perfect record. Drive the naive path in a test;
  a distractor that turns out not to change the outcome stays in the world, out of `traps`.

### Expectations come from an oracle

Write the correct outcome as a function of the seed — `irropsOracle(seed)`,
`backorderOracle(seed)`, `accessOracle(seed)` — and derive the assertions from it. The oracle states
the rules as code, so a reviewer can check it against the handbook and the tool texts; the tests pin
its output as literals, which is what catches an accidental change to the seed.

Then score **per item**, so the score is near-continuous and two runs that fail differently score
differently: `settled:RMA-807`, `assignee:T-2013`, `granted:AR-314`. Three things to watch:

- **An untouched world must score 0.** Where the right outcome for an item is to do nothing (leave a
  return open, hold a request), gate the credit on evidence the item was worked — a comment saying
  why, or a journal read of the receipts for it — or the agent that does nothing earns it.
- **Gate settlement on the action.** Charging nothing for a change that never happened is not a
  correct settlement.
- **A missing record must not switch a rule off.** A check that throws scores 0, which is right for
  an assertion about a record that never arrived and wrong for a penalty that loops over records:
  read what exists instead of looking each id up.

### Records that arrive mid-run

A queue that does not stand still is the most reliable lever the calibration found: strong models
read a list once and never look again. The ops worlds support scheduled arrivals, delivered by the
tool that reaches the trigger and announced by nothing:

```ts
// airline: once four requests are resolved, a new one is open.
arrivals: [{ afterResolved: 4, request: { id: 'Q-311', /* … */ } }],

// support: once the audit log holds three grants, a request and its approval land.
arrivals: [{ afterAudit: { action: 'grant_access', count: 3 }, accessRequests: [/* … */], approvals: [/* … */] }],

// ecommerce: a purchase order received after four allocated lines; a receipt after N refunds.
scheduledDeliveries: [{ afterAllocations: 4, purchaseOrderId: 'PO-91' }],
scheduledReceipts: [{ afterRefunds: 7, receipt: { rmaId: 'RMA-807', /* … */ } }],
```

The trigger is read from world state (resolved requests, the audit log, stock movements, the refund
ledger), never from a counter inside the tool closure, so it survives a strategy that builds a fresh
tool server per phase. Three consequences for the scorer:

- The oracle runs over the **settled** seed, with every arrival applied (`settledBackorderWorld`,
  `settledReturnsWorld`). Where arriving mid-run could change the answer, prove it does not for your
  seed in a test (`ecommerce-backorder-allocation` checks that allocating before and after the
  delivery reaches the same lines as one walk).
- The blast radius must allow the arrival itself (`within('arrivals')`, `addedTo('receipts')`).
- If the right final state would hide a mistake made before the arrival, score the mistake from the
  journal. A refund for the missing parcel issued before the warehouse logged it ends in the same
  final state as a correct one; `refunded-before-receipt` reads the order of refunds instead.

### Seeded variants

`createRng(seed)` ([`rng.ts`](../packages/tasks/src/rng.ts)) is a small deterministic generator for
building a world from a seed. `airline-baggage-audit` is generated this way:
`createBaggageAuditSpec(seed)` yields a different but equally hard instance — each kind of error is
planted a fixed number of times whatever the seed — scored against its own oracle. Use it when a
task's interest is a pattern rather than a particular record, and test more than one seed.

### Text written by the agent

Score prose narrowly: ask whether a fact made it into the text, never whether the text is good.
`mentionsDate(text, '2026-08-14')` ([`text.ts`](../packages/tasks/src/text.ts)) accepts the ISO date
and the day and month in words in either order ("14 August", "Aug 14th"); it rejects numeric forms
such as 08/14, which read differently on either side of the Atlantic.

### Calibrate before you merge

An expert task has to leave room above and below it. Run it with the `single` strategy on a strong
model and a small one, a couple of repeats each, into a scratch results root rather than `results/`,
and read the traces. The target for the tier: on Sonnet 5.5 the single-agent mean lands roughly
between 0.35 and 0.75 with real spread between tasks, the small model lower, and no task scoring 0
for every model (impossible) or 1.0 for every model (saturated).

What the calibration of the current tier showed, so you do not have to rediscover it: Sonnet 5.5
follows a stated procedure over several pages, reads dated bulletins and knowledge-base articles,
and handles a dozen interacting rules without slipping; Opus 5.5 slips less still. What Sonnet
misses is state that changes while it works (a request, delivery or parcel that arrives mid-run:
it lists a queue once and does not look again), history that is not on the record in front of it
(a cabin upgraded after the charge, a colleague's earlier refund, a waiver already used), and cases
outside the list it was given (a duplicate in another queue, a report filed under another service).
A trap that only restates a handbook rule costs it nothing.

The opposite mistake is as easy to make. A rule the handbook never points to, in an article the
obvious search does not return, is missed by every model and measures luck: say where a rule lives,
never what it catches. And mind the mix: the tier as it stands sits above the band on Sonnet 5.5
(about 0.8 single-agent), and most of what Sonnet and Opus still miss is records that arrive
mid-run. A new expert task should lean on a lever of another kind.

---

## Part 3 — a new research task

Research tasks need no new tools: they all share `search` and `fetch_page` over a **frozen corpus** of
public documents ([`fixtures/README.md`](../fixtures/README.md) explains how it is built and checked).
Nothing is recorded or replayed, and a run never touches the network. There are two kinds of task:

- **Judged** (`defineResearchTask`, in
  [`packages/tasks/src/research/tasks.ts`](../packages/tasks/src/research/tasks.ts)): an open
  question graded by a rubric, with a deterministic audit of the citations.
- **Breadth** (`defineBreadthTask`, in
  [`breadthTasks.ts`](../packages/tasks/src/research/breadthTasks.ts)): many small, independent facts,
  each graded against a gold key with no model in the loop. These are the tasks where fanning the work
  out should pay.

A spec is added to `judgedResearchSpecs` or `breadthResearchSpecs` at the bottom of its file; the
registry already spreads both. A judged one looks like this:

```ts
export const httpRedirectsSpec: ResearchTaskSpec = {
  id: 'research-http-redirects',
  title: 'HTTP 301 vs 308',
  question:
    'What is the difference between HTTP status codes 301 and 308? Explain what each one means, ' +
    'how a client is expected to treat the request method and body when following each, whether ' +
    'each is cacheable, and where each is currently specified.',
  difficulty: 'easy',
  tags: ['http', 'specifications', 'comparison'],
  maxTurns: 22,
  // The task's whole web. `search` ranks only these, and fetch_page serves only these.
  corpus: {
    primary: ['rfc9110'],                                   // where the gold answer comes from
    secondary: ['mdn-status-301', 'mdn-status-308'],         // reliable restatements
    superseded: ['rfc7538', 'rfc7231'],                      // earlier versions: the version trap
    distractor: ['mdn-status-307'],                          // plausible but off target
  },
  hypothesis: 'Near the ceiling for every architecture; a verify phase earns its cost only on the MDN trap.',
  traps: [
    {
      id: 'rfc7538-current',
      description: 'Citing RFC 7538 as the current definition of 308; RFC 9110 obsoletes it.',
      caughtBy: ['rubric:specifications'],
    },
  ],
  rubric: [
    {
      id: 'method-preserved-308',
      claim:
        'States that a client following a 308 must not change the request method: a POST is repeated as a POST, with its body.',
      weight: 1.5,
      // Passages that establish the claim. Not used for scoring; the sufficiency test checks each
      // one is in the corpus, which proves the claim can be answered, and quoted, from this web.
      support: [{ doc: 'rfc7538', quote: 'except that it does not allow changing the request method from POST to GET' }],
    },
    // …
  ],
};
```

Constraints:

- **Use the documents the corpus has.** A task names documents by id (`fixtures/corpus/manifest.json`
  lists them). If the question needs a document that is not there, add it (below) rather than
  pointing the task at the live web. Give the task the *wrong* pages as well as the right ones:
  a `superseded` document the current standard replaced, or a `distractor`, is what turns "found a
  source" into "found the right source".
- **The answer must not drift.** Specifications, standards, long-settled semantics. Anything that moves
  with a release cycle makes a task that stops measuring the harness the moment it changes, and the
  corpus is a snapshot, so the gold answer is whatever the snapshot says.
- **Every rubric item is a flat, checkable statement,** phrased so a grader decides whether the
  answer *says* it, not whether the answer is *good*. Quality judgements are where judges disagree.
- **Quotes are checked, not trusted.** The agent is told to cite the URL it relied on and to quote word
  for word. The scorer replays the tool journal against the corpus: a quote counts only if it is in
  the page it cites, the page was opened, and a tool call displayed that passage. A claim with no
  verified quote earns a quarter credit, and citing a page that was never opened is a penalty. You
  write none of this; the sufficiency tests make sure your task can be answered within it.

Weight the items that separate a real answer from a plausible one. In the OWASP-vs-NIST task the
heaviest item (weight 2) is `names-the-conflict` — *explicitly says the two sources disagree* —
because presenting a single confident recommendation is exactly the failure the task exists to
detect.

A breadth task takes the same `corpus` selection, a `key` and `fields` for the answer's shape, and a
list of `items`: each has the expected value per field, a `source` span in the corpus the quote must
come from, and a `goldQuote` that the sufficiency test checks lies inside it. Read one of the three in
[`breadthTasks.ts`](../packages/tasks/src/research/breadthTasks.ts) before writing a fourth.

### Add the documents to the corpus

Skip this if the task's documents are already in `fixtures/corpus`. Otherwise:

1. Add an entry to `CORPUS_SOURCES` in
   [`sources.ts`](../packages/tasks/src/research/sources.ts): an id, the canonical URL, any aliases,
   title, publisher, licence and credit line, and how to extract the text. Prefer a source that may be
   redistributed (see the licensing section of the fixtures README).
2. Fetch just that document and write the notice (network access is needed for this step only):

   ```bash
   npx tsx scripts/build-corpus.ts --only my-document
   ```

3. Commit `fixtures/corpus/manifest.json`, the new `fixtures/corpus/docs/my-document.txt` and
   `fixtures/NOTICE.md` together. Never edit an existing document by hand: `Corpus.load` checks every
   document against its checksum and refuses a changed file.
4. Run `npm run check`. `researchCorpus.test.ts` checks that the manifest matches the source list, that
   every document is credited in the notice, and that every `support` and `goldQuote` passage is in the
   corpus of the task that names it.

A document added to the corpus does not change what existing tasks see, since each task's recorded
corpus hash covers only the documents it names. Re-fetching existing ones is a new snapshot and can
change the answers graded against it; leave that to `--verify` and to an issue.

---

## The tests you must write

Tests are what make a scorer trustworthy: a rubric nobody has exercised is a rubric that scores
everything zero, or everything one, and you will not find out until you have paid for a sweep.

Tests live in `packages/tasks/test/<world>.test.ts` (`<world>-expert.test.ts` for the expert tier)
and run without a network, a key, or the SDK.

### The driver

[`test/harness.ts`](../packages/tasks/test/harness.ts) drives a task's real tool handlers the way the
journaling MCP wrapper does. Arguments go through the tool's own zod shape first, exactly as the MCP
server validates them, so a schema that rejects (or silently strips) what a handler needs fails in
the test instead of in a paid run. The world the driver mutates is the object the scorer is handed,
which is what makes these tests end-to-end:

```ts
import { createDriver, missed, penaltyIds, scoreInput } from './harness';

function drive(spec: ToolUseTaskSpec<AirlineOpsWorld>, world = spec.createWorld()) {
  return createDriver(world, spec.createTools(world));
}

const d = drive(airlineWaiversSpec);
await d.call('get_bulletin', { bulletinId: 'PB-2026-14' });     // must succeed
await d.expectError('list_ledger', { page: 4 });                 // must report an error
const result = await airlineWaiversTask.score(scoreInput(d));
```

`scoreInput` builds the scorer's input with a judge that throws. That is deliberate: it asserts, on
every tool-use test, that nothing in the deterministic path has quietly acquired a dependency on a
model. `missed(score)` lists the breakdown items that did not earn full credit, `earned(score, id)`
reads one (and throws on an unknown id, so a typo cannot pass), and `penaltyIds(score)` lists the
penalties applied.

### 1. Reference solution — scores exactly 1

Script the intended path: read what a careful agent would read, then act. For an expert task, write
it against the oracle so a trap test can re-run it with one item replaced:

```ts
it('scores 1 on the reference solution', async () => {
  const d = drive(ecommerceReturnsSpec);
  await solve(d);                       // reads, then settles every return from the oracle
  const result = await score(ecommerceReturnsTask, d);
  expect(result.penalties).toEqual([]);
  expect(missed(result)).toEqual([]);
  expect(result.score).toBe(1);
  expect(findProduct(d.world, 'P-MOU')).toMatchObject({ stock: 22, damagedStock: 2 });
});
```

Assert the world *and* the score. A test that only checks `score === 1` will still pass if two
assertions are broken in compensating directions.

### 2. Untouched world — scores exactly 0

The agent that does nothing must score nothing. This catches an assertion that is accidentally
satisfied by the seed:

```ts
it('scores 0 on an untouched world', async () => {
  const result = await score(ecommerceReturnsTask, drive(ecommerceReturnsSpec));
  expect(result.score).toBe(0);
  expect(result.penalties).toEqual([]);
});
```

### 3. Every rule and every trap — the naive path is caught

One test per forbidden rule, asserting the specific penalty id and, for a hard fail, the zero. For
an expert task, one test per trap: drive the naive path the trap describes and assert that
`firedTraps` names it (and, where you can, nothing else):

```ts
it('trap page-by-deadline: correcting the commander afterwards does not undo the page', async () => {
  const d = drive(supportIncidentSpec);
  await solve(d, { page: 'E-402' });
  await d.call('page_engineer', { engineerId: 'E-401', message: 'Take command', incidentId: 'INC-1' });
  await d.call('assign_incident_role', { incidentId: 'INC-1', role: 'commander', engineerId: 'E-401' });
  const result = await score(supportIncidentTask, d);
  expect(penaltyIds(result)).toEqual(['paged-wrong-engineer']);
  expect(result.score).toBe(0.5);
});
```

Also test partial credit — the case where nothing is *forbidden* but something is *wrong* — so you
know the breakdown discriminates rather than collapsing to 0 or 1.

### 4. Try to break it

Before you calibrate, play two agents against your scorer: one that wants 1.0 without doing the
job, and a careful one the scorer might mark down. Write every hole you find as a test, then fix
the task. A red-team pass over the current tier found the following, so look for them in yours:

- **Judge eligibility on the seed.** A penalty that asked whether the *final* booking was
  refundable let an agent move a basic-economy fare into economy before cancelling, then refund it
  to the card (`airline-hard`). What a customer bought, held or was owed is read off the seed.
- **Count every way money leaves.** A refund on top of a re-protected seat, store credit on top of a
  card refund, and an apology credit nobody asked for each scored 1.0 or close to it until a rule
  counted them (`airline-irrops-reprotect`, `ecommerce-returns-desk`, `ecommerce-inbox-triage`). A
  rule for one kind of overpayment should cover its siblings: the audit penalised refunding a
  correct charge, but not refunding an overcharge in full when only part of it was owed.
- **A penalty tests exactly what it names.** The freeze and separation-of-duties rules fired on a
  read grant, which breaks neither (`support-access-requests`); the look-alike rule looked only at
  the two planted look-alikes, so linking any other ticket to the incident, or closing a
  look-alike, cost nothing (`support-major-incident`).
- **Where the policy caps, accept everything under the cap.** "Grant no more than the lowest level
  every approver approved" does not say whether to grant that level or to hold the request for the
  rest. Opus and Sonnet held it; the scorer wanted the grant and marked them down.
- **Read your own world for problems you did not plan.** A knowledge-base article that covered two
  tickets made them duplicates, one in the queue and one outside it, and merging them, as the task
  requires for its planned duplicates, failed the run on the blast radius (`support-monday-triage`).
- **Leave no edge to interpretation.** "Between 08-02 and 08-04" with a booking on the 4th; a
  deadline that can be written as 23:59 or as the midnight after; a fee "deducted from what is
  returned" in a ledger where every fee is its own entry. Write "from … through …", accept both
  spellings of a deadline, and say how a fee is taken.
- **A binding rule that nothing scores is an injection's free pass.** The note pasted into one
  cancellation request asks the agent to skip the refund-policy lookup. Until the lookup was scored,
  an agent that obeyed that half of the note lost nothing.

### Also worth testing

- **Read-only tools are read-only**: call every read tool and assert the world still equals a fresh
  seed. Do it once per world, and once per ops world.
- **The oracle is pinned**: its output as literals, so a change to the seed is a visible test change.
- **The blast radius does not punish the job**: telling a customer about their own case is not
  collateral damage, telling anyone else is.
- **Mid-run arrivals**: the arrival is invisible before its trigger and present after it, and the
  reply that triggers it says nothing about it.
- **Task metadata**: ids, difficulty, a hypothesis that names a mechanism, at least a handful of
  traps, a handbook free of record ids, a `maxTurns` that leaves room for the reference path.
- **Tool error handling**: unknown ids and impossible operations report errors instead of
  throwing, and the world is unchanged afterwards.

For research tasks, write a small corpus to a temporary directory (`writeCorpus` in
[`researchHelpers.ts`](../packages/tasks/test/researchHelpers.ts)), drive the real `search` and
`fetch_page` tools over it (`callTool`), and use a fake `Judge` that returns canned verdicts. The
suites to read are [`research.test.ts`](../packages/tasks/test/research.test.ts) (rubric and gold-key
scoring), [`researchCitations.test.ts`](../packages/tasks/test/researchCitations.test.ts) (which quotes
count) and [`researchCorpus.test.ts`](../packages/tasks/test/researchCorpus.test.ts) (the corpus, the
tools, and the "shipped corpus sufficiency" tests that every new spec is checked against).

---

## Before you open the PR

```bash
npm run check         # typecheck + all tests
npm run check:wiring  # optional: asserts your MCP tools actually register with a real session
```

Then run your task for real, cheaply, and read the trace:

```bash
npm run bench -- run --strategies single --tasks my-new-task --repeats 2 \
  --model claude-sonnet-5-5 --max-cost 2 --total-budget 5
npm run dev:web
```

If `single` scores 1 on every attempt, the task is too easy to separate architectures; see
[Calibrate before you merge](#calibrate-before-you-merge) for what tends to help. If every run
scores 0, check that the rules are discoverable from the handbook and the tools rather than only
from your own head.
