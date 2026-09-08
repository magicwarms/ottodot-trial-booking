# Ottodot — Trial Booking

A trial-class booking slice that stays correct when payments fail and when two
parents want the same last seat.

Trial classes hold **4 students**. The system guarantees that a class never has
more than 4 confirmed students, that a child is never confirmed twice into the
same class, that a declined payment never puts a child on a roster, and that
**at most one parent can win the last seat** — including when they pay at the
same instant.

---

## How to run

Requires Node 20 or newer.

```bash
npm install
npm run seed     # builds trial-booking.db with the demo data
npm test         # 16 tests: invariants, the last-seat scenario, real concurrency
npm run dev      # http://localhost:3000
```

Then:

| Page | What it is |
|---|---|
| <http://localhost:3000> | Parent: pick a child, pick a class, book |
| <http://localhost:3000/roster> | Admin/teacher roster |
| <http://localhost:3000/api/roster> | Roster JSON (`?classId=2` for one class) |

Two extra commands:

```bash
npm run verify     # asserts the invariants directly against the database file
npm run take-seat  # demo helper: another parent takes a seat (see below)
npm run build      # production build
```

> **If `npm install` warns about blocked install scripts** (npm 11+ blocks them
> by default), `better-sqlite3` may not have unpacked its native binary. Run
> `npm approve-scripts` or `npm rebuild better-sqlite3` and re-run. Nothing else
> in the project needs a build step.

### Demo path (2 minutes)

1. `npm run seed`. Class **#2 Math / Mr Chen has exactly 3 of 4 seats taken.**
2. Open `/`, choose **Arjun Nair**, choose **Math / Mr Chen**, continue. The
   booking is `pending_payment` and explicitly **holds no seat**.
3. In another terminal, let a different parent take that last seat:
   ```bash
   npm run take-seat
   ```
   It picks an eligible child, books, and pays — from a separate process with
   its own database connection. Output:
   ```
   Class #2 — Math with Mr Chen
     before: 3/4 confirmed, 1 seat(s) left
     Rafi Rahayu paid and took seat 4 (booking #10)
     after:  4/4 confirmed, 0 seat(s) left

   The class is now FULL. Go press Pay in the browser — that payment must not confirm.
   ```
4. Back in the browser, press **Pay**. The result is `cancelled_seat_taken`,
   with a `succeeded` charge followed by a `refunded` entry. Arjun is **not** on
   `/roster`.
5. Try booking Aisha into Science / Ms Lim again — rejected as a duplicate.
6. Book anyone into Math / Ms Devi and choose **"Payment is declined"** — the
   booking lands in `payment_failed` with no seat, and the roster is unchanged.

---

## What I built

A Next.js 15 App Router app over a SQLite database.

- **Parent flow** — choose a child, see live seat counts, submit a booking, run
  a mock payment (success or decline, your choice), and see the resulting status
  with the full payment-attempt history.
- **Admin/teacher roster** — an HTML page and a JSON endpoint, both showing
  confirmed students only, with their assigned seat numbers.
- **All business rules in one module**, `lib/booking.ts`. Server actions and the
  API route are thin wrappers, so the tests drive the same code the app runs.
- **Invariants enforced in the database**, not only in application code.
- **16 tests**, including the brief's last-seat scenario step-for-step and a
  multi-threaded stampede on a single seat.

```
app/page.tsx              parent: pick child -> pick class -> book
app/booking/[id]/page.tsx status, mock payment, payment history
app/roster/page.tsx       admin/teacher roster
app/api/roster/route.ts   GET /api/roster
app/actions.ts            server actions (thin)
lib/booking.ts            ALL business logic
lib/db.ts                 connection + PRAGMAs
db/schema.sql             tables, CHECKs, partial unique indexes
db/seed.ts                synthetic data covering the required edge cases
db/verify.ts              invariant assertions against a live database
db/take-seat.ts           demo helper for the last-seat race
test/                     invariants, last-seat scenario, real concurrency
```

---

## Time spent

<!-- TODO before submitting: replace with your actual figure. -->
Roughly **3.5 hours**, within the 4-hour cap:

| | |
|---|---|
| Reading the brief, deciding the data model and race strategy | ~45 min |
| Schema, `lib/booking.ts` | ~60 min |
| Tests (invariants, scenario, worker-thread concurrency) | ~50 min |
| UI, server actions, roster API | ~40 min |
| Seed, verification script, this README | ~35 min |

---

## Assumptions I made

- **Trial bookings only.** No regular enrollment, per the brief.
- **The 4-seat cap is a domain constant**, not per-class configuration. The
  schema hardcodes seats `1..4`; `capacity` exists as a column but the hard
  guarantee is the seat range.
- **The payment provider is mocked and its result is chosen in the UI.** A real
  integration would use a provider-issued idempotency key; `provider_ref` stands
  in for that and is `UNIQUE`.
- **No authentication.** Every parent and every admin is trusted. A real system
  would scope `/roster` to staff and the booking flow to the signed-in parent.
- **A refund is recorded, not executed.** Writing a `refunded` row is the
  mocked equivalent of calling the provider's refund API.
- **Timestamps are ISO-8601 UTC strings.** Display converts to a readable form;
  no timezone handling beyond that.
- **Single-node deployment.** SQLite with one writer is the right size for this
  slice; see "what I would do next" for the multi-node story.

---

## Backend design

### Data model

Five tables — `parents`, `students`, `trial_classes`, `bookings`,
`payment_attempts` (full DDL in [`db/schema.sql`](db/schema.sql)).

```
parents ─< students ─< bookings >─ trial_classes
                          │
                          └─< payment_attempts
```

The interesting column is `bookings.seat_no`. Rather than counting rows to
decide whether a class is full, **every confirmed booking occupies a numbered
seat, 1 through 4.** That turns "don't overbook" from a rule the application has
to remember into a constraint the database can enforce:

```sql
-- at most one confirmed booking per (student, class)
CREATE UNIQUE INDEX ux_confirmed_student_class
  ON bookings (student_id, trial_class_id) WHERE status = 'confirmed';

-- at most one confirmed booking per (class, seat)
CREATE UNIQUE INDEX ux_confirmed_class_seat
  ON bookings (trial_class_id, seat_no) WHERE status = 'confirmed';

-- seats are 1..4, so the seat space is finite by construction
CHECK (seat_no IS NULL OR seat_no BETWEEN 1 AND 4)

-- a booking holds a seat if and only if it is confirmed
CHECK ((status = 'confirmed') = (seat_no IS NOT NULL))
```

Both indexes are **partial** — `WHERE status = 'confirmed'`. That is deliberate:
a child who was declined must be free to try again, so non-confirmed rows are
unconstrained and a `payment_failed` row never blocks a retry.

The last `CHECK` is what makes payment failure safe structurally rather than by
convention: there is no way to write a confirmed booking without a seat, and no
way to write a seat onto a booking that is not confirmed.

### Key backend functions

All in `lib/booking.ts`. They take a database handle and return a result object,
so nothing about them is Next-specific.

| Function | Called from | Purpose |
|---|---|---|
| `createBooking(db, {studentId, classId})` | `createBookingAction` | Create a `pending_payment` booking. No seat is held. |
| `payBooking(db, {bookingId, simulate})` | `payBookingAction` | Charge, then atomically claim a seat. The whole safety story lives here. |
| `getRoster(db, classId?)` | `/roster`, `GET /api/roster` | Confirmed students with seat numbers. |
| `listClasses(db)` | `/` | Classes with advisory `seats_left`. |
| `getBookingDetail(db, id)` | `/booking/[id]` | Status plus payment-attempt history. |

Surfaces: two server actions (`app/actions.ts`), one route handler
(`GET /api/roster`), three pages.

### Booking statuses

| Status | Meaning | Holds a seat? |
|---|---|---|
| `pending_payment` | Selected, not yet paid | No |
| `confirmed` | Paid and seated; on the roster | **Yes** |
| `payment_failed` | Provider declined the charge | No |
| `cancelled_seat_taken` | Charge succeeded but the last seat was gone; refunded | No |
| `cancelled` | Cancelled; any charge refunded | No |

`pending_payment` is the only status a payment can act on. Everything else is
terminal — a retry creates a new booking rather than resurrecting an old one.

### How duplicate bookings are prevented

Three layers, only one of which is authoritative.

1. The UI shows a friendly error.
2. `createBooking` checks for an existing confirmed booking and returns
   `ALREADY_BOOKED`. `payBooking` re-checks under the write lock, in case a
   duplicate was confirmed while this parent was paying — if so, the charge is
   refunded and the booking becomes `cancelled`.
3. **`ux_confirmed_student_class` rejects the row.** This is the guarantee. A
   test writes a duplicate row directly, bypassing all application code, and
   asserts the database refuses it.

Re-submitting the *same* selection is not treated as an error — `createBooking`
returns the existing open booking, so a double-click or a browser back-button
does not create clutter.

### How payment failure is handled

The charge happens outside the transaction (a real provider call must not be
held inside a database write lock). Then a single `BEGIN IMMEDIATE` transaction
records the attempt and decides the outcome.

If the charge failed, the booking moves to `payment_failed` and **no seat is
assigned**. Because of the `(status = 'confirmed') = (seat_no IS NOT NULL)`
CHECK, there is no code path — buggy or otherwise — that can put a declined
booking on a roster.

Every path that returns *after* a successful charge writes a `refunded` attempt
before returning. Money and roster state move together or not at all.

### How two users competing for the last seat is handled

See the dedicated section below.

### Which checks belong where

| Check | UI | Server action | Database | Background job |
|---|---|---|---|---|
| Seats-left display | advisory, assumed stale | — | — | — |
| Fast-fail on a full class | disables the radio | pre-charge count | — | — |
| Duplicate confirmed booking | friendly error | friendly error | **authoritative** — `ux_confirmed_student_class` | — |
| Capacity ≤ 4 | — | seat claim in `BEGIN IMMEDIATE` | **authoritative** — `ux_confirmed_class_seat` + `CHECK 1..4` | — |
| Declined payment never confirms | — | **authoritative** — single transition function | `CHECK` ties seat to status | — |
| Double-click / replayed payment | — | `INVALID_STATE` + `provider_ref UNIQUE` | unique index | — |
| Expiring stale `pending_payment` rows | — | — | — | **not built** — see "deliberately cut" |

The principle: the UI optimises, the server explains, **the database guarantees.**
Anything a race can break belongs in the last column.

---

## The last-seat race

The scenario from the brief:

1. User A selects the last available slot and moves to payment.
2. User B selects the same slot.
3. User B completes payment first and confirms the booking.
4. User A then tries to complete payment.

### The approach I chose

**Selecting a slot reserves nothing. The seat is claimed at payment time, inside
the same `BEGIN IMMEDIATE` transaction that settles the payment.**

```
payBooking:
  1. charge the (mock) provider            <- outside any transaction
  2. BEGIN IMMEDIATE                       <- takes SQLite's write lock
       record the payment attempt
       re-check the booking is still pending
       re-check no duplicate confirmed booking appeared
       seat = lowest free seat in 1..4
       no seat?  -> refund, status = cancelled_seat_taken
       otherwise -> status = confirmed, seat_no = seat
     COMMIT
```

`BEGIN IMMEDIATE` grabs the write lock at the *start* of the transaction rather
than on first write, so exactly one payment at a time can be inside that block
for a given database. "Find a free seat and take it" is therefore atomic, and
the two partial unique indexes are the backstop if any future code path ever
tries to claim a seat outside this function.

In step 4, User A's charge succeeds, but by the time A holds the write lock all
four seats are gone. A is refunded and parked in `cancelled_seat_taken`. A never
becomes confirmed, and the class ends with exactly 4 confirmed students.

### Why I chose it

**It matches the scenario as written.** The alternative — holding a seat the
moment a parent selects a slot — would block User B at step 2, so steps 3 and 4
could not happen at all. Holds also need an expiry sweeper, because a parent who
closes the tab would otherwise freeze a seat forever; that is a background job,
a TTL to tune, and a new class of bug ("why does the class show full when it
isn't?"), all before the first real customer.

**It puts the guarantee in the database.** Seat numbers plus a partial unique
index mean overbooking is not merely unlikely under concurrency — there is no
row the database would accept. That survives a future engineer adding a second
endpoint without reading this README.

**It fails in the direction that is recoverable.** The worst case is a refund,
which is annoying. The alternative failure — two children confirmed for one seat
— is a parent arriving at a class with no place for their kid. Refunds are
cheaper than that.

### What tradeoffs I accepted

- **The loser can be charged and then immediately refunded.** This is the real
  cost of the design. It is mitigated but not eliminated: `createBooking`
  rejects a visibly-full class before anyone reaches the payment page, so the
  window is only the duration of one payment. The correct fix is
  **authorize-then-capture** — reserve the funds, claim the seat, capture only
  on success, void otherwise. That needs a real provider, so it is future work.
- **`BEGIN IMMEDIATE` serialises all booking confirmations**, not just those for
  the same class. At trial-booking volume that is irrelevant; at scale it is the
  first thing to fix, by moving to Postgres and locking the class row
  (`SELECT … FROM trial_classes WHERE id = ? FOR UPDATE`) instead of the whole
  database. The invariants and the schema carry over unchanged — only the
  locking primitive differs.
- **Refunds are recorded, not executed.** A `refunded` row is written; no
  provider is called.
- **A loser is not auto-waitlisted or offered another class.** They see a clear
  explanation and a link to book again.

### How it is verified

`test/race.test.ts` runs the brief's four steps in order and asserts that
exactly one of A and B is confirmed, that the loser is `cancelled_seat_taken`
with a matching refund, and that the class holds exactly 4 confirmed students.
It also runs the mirror case (A pays first) to show the outcome is not an
artifact of ordering.

`test/concurrency.test.ts` removes the ordering entirely: **8 worker threads,
each with its own database connection**, spin on a shared start time and all try
to pay for one remaining seat at the same instant. Exactly one wins; the other
seven are refunded. A second case starts 12 threads against an empty class and
asserts exactly 4 winners holding seats 1, 2, 3, 4.

---

## What I deliberately cut

- **Regular enrollment.** The brief says trial booking only.
- **Authentication and authorisation.** No login; `/roster` is open. It is the
  first thing I would add, and it changes no business logic.
- **A hold-expiry background job.** Not needed, because selection holds nothing.
  It becomes necessary only if the design moves to reserve-on-select.
- **Real payment integration**, including authorize-then-capture and webhook
  reconciliation.
- **Waitlists, cancellation by parents, rescheduling, notification emails.**
- **Per-class variable capacity.** The cap is a domain constant here.
- **Frontend polish.** The brief explicitly deprioritises it: no design system,
  no client-side state, no animation. Plain server-rendered forms.

## What I would monitor after release

- **The invariants themselves, continuously.** `db/verify.ts` is written to run
  against a live database: classes over capacity, children confirmed twice, two
  bookings sharing a seat, confirmed bookings without a seat, unconfirmed
  bookings holding one. Any non-zero result is a page-someone alert, because
  each means a teacher's roster is wrong.
- **`cancelled_seat_taken` rate.** This is the charge-then-refund case. A low
  rate is the cost of the design; a rising rate means demand is concentrating on
  nearly-full classes and it is time to implement authorize-then-capture.
- **Refunds without a matching successful charge, and successful charges without
  a settled booking.** Either direction is money and roster state drifting apart.
- **`pending_payment` age distribution.** A growing tail of old pending bookings
  means parents are abandoning at the payment step.
- **`SQLITE_BUSY` / lock-wait time on `payBooking`.** The early-warning signal
  that the single-writer design is running out of room.
- **Payment decline rate by reason**, to separate "our bug" from "their card".

## What I would do next with more time

1. **Authorize-then-capture**, removing the charge-then-refund window entirely.
2. **Postgres**, with `SELECT … FOR UPDATE` on the class row so confirmations
   for different classes stop serialising against each other. The schema and
   both partial unique indexes port directly.
3. **Authentication**, scoping the roster to staff and bookings to the parent.
4. **Idempotency keys on the HTTP boundary**, not just on the payment record, so
   a retried request is safe end to end.
5. **Provider webhooks and a reconciliation job**, for the case where a charge
   succeeds but the response never reaches us.
6. **A waitlist**, which the seat model already supports: a freed seat is simply
   an unoccupied number.
7. **Property-based tests** over random interleavings of book/pay/cancel,
   asserting the invariants after every operation.

---

## Test output

```
$ npm test

ok 1 - 8 threads racing for 1 seat: exactly one wins, seven are refunded
ok 2 - 12 threads racing for an empty class: exactly 4 win, seats are 1..4
ok 3 - duplicate: the same child cannot be confirmed twice into the same class
ok 4 - duplicate: the database rejects a second confirmed row even if app logic is bypassed
ok 5 - overbooking: a 5th student cannot be confirmed into a 4-seat class
ok 6 - overbooking: the database rejects a 5th confirmed row (seat space is 1..4)
ok 7 - payment failure: the child is not added to the confirmed roster
ok 8 - payment failure: a confirmed booking can never exist without a seat
ok 9 - retry: after a declined payment the parent can book again and succeed
ok 10 - idempotency: paying the same booking twice confirms once and charges once
ok 11 - resubmitting the same selection reuses the open booking
ok 12 - roster shows confirmed students only, with seats 1..4
ok 13 - last-seat race: exactly one of A and B ends up confirmed
ok 14 - last-seat race: A wins if A pays first (the scenario is symmetric)
ok 15 - last-seat race: a losing payment that also FAILS is not refunded twice
ok 16 - last-seat race: a cancelled seat is released and re-usable
# tests 16
# pass 16
# fail 0
```

```
$ npm run verify

  ok    no class has more than its capacity confirmed
  ok    no child is confirmed twice in the same class
  ok    no two confirmed bookings share a seat
  ok    every confirmed booking holds a seat in 1..4
  ok    no unconfirmed booking holds a seat
  ok    no failed payment left a child on the roster
  ok    every lost/cancelled paid booking was refunded

All invariants hold.
```

See [AI_USAGE.md](AI_USAGE.md) for how AI tools were used on this take-home.
