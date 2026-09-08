# Walkthrough script (5–8 minutes)

Not a deliverable — a crib sheet for recording the video the brief asks for.
**Delete this file before submitting if you would rather not ship it.**

Record with Loom or an unlisted YouTube upload. Screen + voice. Don't over-rehearse;
they want to hear you reason, not perform.

**Before you hit record**

```bash
npm run seed          # clean state, class #2 sits at exactly 3/4
npm run dev
```

Have open: a terminal, the browser at `http://localhost:3000`, and an editor
showing `db/schema.sql` and `lib/booking.ts`.

---

### 0:00 — What this is (30s)

> "Trial booking for Ottodot. Classes cap at 4. The interesting part isn't the
> UI, it's making sure a class never ends up with 5 kids and a declined payment
> never puts a kid on a roster. I'll show it working, then show why it's correct."

### 0:30 — The data model (90s)

Open `db/schema.sql`. Point at the two partial indexes and the two CHECKs.

> "The decision that shapes everything: a confirmed booking doesn't just exist,
> it **occupies a numbered seat, 1 to 4**. So 'don't overbook' isn't a rule my
> code has to remember — the seat space is finite and there's a unique index on
> (class, seat). There's no row the database would accept that breaks it.
>
> Both indexes are partial, `WHERE status = 'confirmed'`. That's on purpose: if
> your payment fails you have to be able to try again, so non-confirmed rows are
> unconstrained.
>
> And this CHECK — a booking holds a seat **if and only if** it's confirmed.
> That's what makes payment failure structurally safe, not safe-by-convention."

### 2:00 — Happy path (45s)

Book Arjun into a class with seats. Pay, succeed. Show `/roster` — he's there
with a seat number.

> "Note the booking sits at `pending_payment` first, and it holds **no seat**."

### 2:45 — Payment failure (45s)

Book into Math / Ms Devi, choose **"Payment is declined"**.

> "`payment_failed`, no seat held, and the payment attempt is recorded with its
> reason. Check the roster — unchanged. He was never on it, not even briefly."

### 3:30 — The last-seat race, live (2 min)

**This is the part they care about. Don't rush it.**

Class #2 has 1 seat left. Book **Arjun** into it, stop at the payment page.

> "Arjun is User A. He's on the payment page looking at the last seat. He holds
> nothing."

Switch to the terminal, run the snippet from the README §Demo path step 3.

> "That's User B. Different process, own database connection. B just paid and
> took the last seat. The class is now full."

Switch back. Press **Pay**.

> "A's card charges fine — but by the time A gets the write lock, there's no
> seat. So: `cancelled_seat_taken`, and look at the payment history — `succeeded`
> then `refunded`, reason `class_full_at_capture`.
>
> That's the tradeoff I accepted and I want to be upfront about it: **the loser
> can get charged and refunded.** The right fix is authorize-then-capture, which
> needs a real payment provider. What I would not accept is the other failure —
> two kids confirmed for one seat, and a parent showing up to a full class."

Show `/roster` — Arjun absent, exactly 4 confirmed.

### 5:30 — Why claim-at-payment, not hold-at-select (45s)

> "The obvious design is to reserve the seat when you pick the slot. I didn't,
> for two reasons. One, it contradicts the brief's own scenario — B is supposed
> to be able to select the same slot while A is paying; under a hold, B is
> blocked and steps 3 and 4 never happen. Two, holds need an expiry sweeper,
> because someone closing their tab would freeze a seat forever. That's a
> background job and a TTL to tune before you have a single customer."

### 6:15 — Verification (60s)

```bash
npm test
```

> "16 tests. The scenario, step for step. And this one —" *(point at
> concurrency)* "— **8 real threads, 8 separate database connections, all paying
> for one seat at the same instant.** Exactly one wins, seven get refunded. Plus
> 12 threads on an empty class: exactly 4 winners, seats 1 through 4.
>
> And several of these tests bypass my code entirely — they INSERT straight into
> the table to prove the **database** refuses a duplicate, a fifth seat, a
> confirmed booking with no seat. If my application logic were wrong tomorrow,
> those still hold."

```bash
npm run verify
```

> "And this checks the live database for violations rather than checking code
> paths. It's what I'd run in production after an incident."

### 7:15 — What I cut, what's next (30s)

> "Cut: auth, real payments, waitlists, any frontend polish — the brief said
> prioritise backend correctness. Next: authorize-then-capture to close the
> refund window, and Postgres with `SELECT FOR UPDATE` on the class row so
> confirmations for different classes stop serialising. The schema and both
> indexes port over unchanged — only the locking primitive changes."

---

**Things to say out loud somewhere:** where each check lives (UI optimises,
server explains, database guarantees), that seat counts in the UI are knowingly
stale, and roughly how long it took you.

**Don't** read the README aloud. They can read.
