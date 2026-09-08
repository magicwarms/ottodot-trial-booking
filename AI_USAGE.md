# AI usage

<!--
TODO before submitting: read this through and make it yours. It was drafted from
the actual session, but it is a statement about YOUR workflow and you should be
able to defend every line of it in the walkthrough video.
-->

## Which AI tools I used

**Claude Code** (Anthropic's CLI agent, running Opus) for the entire build —
reading the brief, designing the schema, writing the implementation, the tests,
and this documentation. It also drove a headless Chrome session to click through
the finished UI.

No other AI tools. No Copilot, no ChatGPT.

## What I used AI for

Effectively all of it, but with the work split deliberately:

- **Design conversation before any code.** I had it read the PDF and argue
  through the data model and the last-seat strategy with me. I made the calls;
  it pressure-tested them and wrote them up.
- **Implementation** — schema, `lib/booking.ts`, the Next.js pages and server
  actions, the seed script.
- **Tests**, including the worker-thread concurrency harness, which is the part
  I would have been slowest at by hand.
- **Documentation** — README structure and this file.
- **Verification** — driving the running app in a browser and checking the
  database afterwards.

What I did *not* delegate: the architectural decisions. Where the seat lives,
when it is claimed, and which layer owns which check are the decisions this
take-home is actually about, and I kept them.

## One place where AI helped me move faster

The **worker-thread concurrency test**. A deterministic test of the brief's
scenario is easy — call the functions in order and assert. Proving the invariant
holds under *genuine* parallelism is fiddlier: you need N threads with N separate
database connections, all released at the same instant, and a way to collect
their results.

That harness took a few minutes instead of the half-hour I would have spent on
the plumbing, which left time to add the second case (12 threads on an empty
class, asserting exactly 4 winners with seats 1–4). It also surfaced a real
environment problem I would have hit anyway: worker threads do not inherit the
parent's TypeScript loader. The first fix attempted (passing `execArgv`) did not
work; the working fix is a small `.mjs` bootstrap that registers the loader
before importing the worker body. That is `test/seat-worker.mjs`.

## One place where I disagreed with, corrected, or rejected AI output

**Two worth naming.**

**1. I rejected reserve-on-select.** The reflexive design for a seat race — and
the one that came up first — is to hold the seat when the parent selects the
slot. It is intuitive and it is wrong for this brief: the scenario explicitly has
User B selecting the same slot *after* User A has moved to payment. Under a hold,
B is blocked at step 2 and steps 3 and 4 never happen. Reserve-on-select also
drags in a hold-expiry background job to stop abandoned carts freezing seats.

I chose claim-at-payment instead, and accepted the charge-then-refund window as
the explicit tradeoff. That decision is argued in the README rather than hidden,
because it is the one a reviewer should push back on.

**2. I caught an incomplete requirements pass.** After the first plan was
written, I asked it point-blank whether every requirement in the PDF was covered.
Re-reading the brief line by line turned up several real gaps in that plan:

- no `price_cents` anywhere, even though the brief says parents "book **and
  pay**" — `payment_attempts.amount_cents` had nothing to draw from
- capacity was only enforced by application logic and a count; the `CHECK
  (seat_no BETWEEN 1 AND 4)` that makes overbooking structurally impossible was
  missing
- the AI_USAGE requirements had been summarised rather than enumerated, so "what
  you would change about your AI workflow" was on track to be dropped
- no test for a double-submitted payment

The lesson I took from it: an agent will confidently tell you a plan is complete.
Checking that claim against the source document is my job, not its job, and it is
worth doing explicitly rather than assuming.

## What I would change about my AI workflow if I had to do this again

- **Build the requirements checklist first, from the source document, before any
  design discussion.** I did the traceability pass second, after being prompted
  to, and it found real gaps. Doing it first would have caught them for free.
- **Write the invariants as failing tests before the implementation.** The tests
  here were written after `lib/booking.ts` and they all passed on the first run —
  which is a weaker signal than I would like. Tests that have never failed have
  not been shown to be able to fail.
- **Ask for the constraint before asking for the code.** The best part of this
  design is the schema, not the TypeScript. Every minute spent on "what can the
  database refuse to store?" was worth more than a minute spent on application
  logic.
- **Push back harder on the first design offered.** The first answer to a
  concurrency problem is usually the conventional one. Here the conventional one
  contradicted the brief.

## How I verified the final implementation

Four independent layers, because tests written alongside code share its blind
spots:

1. **16 automated tests** (`npm test`) covering duplicate prevention,
   overbooking, payment failure, retry-after-failure, payment idempotency, roster
   filtering, the brief's last-seat scenario step for step, and real
   multi-threaded contention. All pass.
2. **Tests that bypass the application entirely.** Several tests `INSERT`
   straight into `bookings` to prove the *database* rejects a duplicate confirmed
   booking, a fifth seat, and a confirmed booking with no seat. This is what
   demonstrates the invariants do not depend on `lib/booking.ts` being correct.
3. **Manual walkthrough of the running app in a browser**, exercising every path:
   the happy path, a declined payment, a duplicate attempt, a full class, and —
   the important one — the real race. I left a booking sitting on the payment
   page, took its last seat from a second process, then pressed Pay. The result
   was `cancelled_seat_taken` with a `succeeded` charge followed by a `refunded`
   entry, and that child absent from the roster.
4. **`npm run verify`**, which queries the live database for violations rather
   than asserting on code paths — over-capacity classes, doubly-confirmed
   children, shared seats, seats held by unconfirmed bookings, paid-but-cancelled
   bookings with no refund. Run after the manual walkthrough above, against a
   database that had actually been through all of it. Clean.

`npm run build` also completes without type or lint errors.
