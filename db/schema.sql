-- Ottodot trial booking — schema.
--
-- Design note: the correctness-critical rules are enforced HERE, in the
-- database, not in application code. Application code can be bypassed by a
-- future endpoint, a migration script, or someone in a psql shell. A unique
-- index cannot.

PRAGMA foreign_keys = ON;

CREATE TABLE parents (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE students (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  name      TEXT NOT NULL,
  grade     TEXT NOT NULL
);

CREATE TABLE trial_classes (
  id          INTEGER PRIMARY KEY,
  subject     TEXT    NOT NULL,
  teacher     TEXT    NOT NULL,
  starts_at   TEXT    NOT NULL,                        -- ISO-8601 UTC
  capacity    INTEGER NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 4),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE bookings (
  id             INTEGER PRIMARY KEY,
  student_id     INTEGER NOT NULL REFERENCES students(id),
  trial_class_id INTEGER NOT NULL REFERENCES trial_classes(id),
  status         TEXT    NOT NULL CHECK (status IN (
                   'pending_payment',
                   'confirmed',
                   'payment_failed',
                   'cancelled_seat_taken',
                   'cancelled'
                 )),

  -- Which of the class's 4 seats this booking holds. Set ONLY while confirmed.
  seat_no        INTEGER,

  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- I3: seats are 1..4. Trial classes are capped at 4 students, so the seat
  -- space is finite by construction. Combined with ux_confirmed_class_seat
  -- below, exceeding 4 confirmed students is not merely unlikely — there is
  -- no row the database would accept.
  -- ponytail: 4 is hardcoded because the cap is a domain constant. Per-class
  -- variable capacity needs a trigger (SQLite) or an exclusion constraint
  -- (Postgres); see README "what I would do next".
  CHECK (seat_no IS NULL OR seat_no BETWEEN 1 AND 4),

  -- I4: a booking holds a seat if and only if it is confirmed. Any transition
  -- away from 'confirmed' must null seat_no, which is what frees the seat.
  -- This is what makes "payment failed" structurally incapable of occupying
  -- a roster slot.
  CHECK ((status = 'confirmed') = (seat_no IS NOT NULL))
);

-- I1: at most ONE confirmed booking per (student, class).
-- Deliberately PARTIAL: non-confirmed rows are unconstrained, because
-- re-attempting after a failed payment is legitimate and must not be blocked
-- by the row that recorded the failure.
CREATE UNIQUE INDEX ux_confirmed_student_class
  ON bookings (student_id, trial_class_id)
  WHERE status = 'confirmed';

-- I2: at most ONE confirmed booking per (class, seat). This is the invariant
-- that actually stops overbooking, including under concurrency.
CREATE UNIQUE INDEX ux_confirmed_class_seat
  ON bookings (trial_class_id, seat_no)
  WHERE status = 'confirmed';

CREATE INDEX ix_bookings_class ON bookings (trial_class_id);

CREATE TABLE payment_attempts (
  id             INTEGER PRIMARY KEY,
  booking_id     INTEGER NOT NULL REFERENCES bookings(id),

  -- Mock provider's charge reference. UNIQUE, so it doubles as the
  -- idempotency key: replaying the same charge cannot double-record it.
  provider_ref   TEXT    NOT NULL UNIQUE,

  outcome        TEXT    NOT NULL CHECK (outcome IN ('succeeded','failed','refunded')),
  amount_cents   INTEGER NOT NULL,
  failure_reason TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_payments_booking ON payment_attempts (booking_id);
