/**
 * All trial-booking business logic.
 *
 * Everything here takes a `DB` handle as its first argument and returns a
 * plain result object. Nothing imports React, Next, or a request context, so
 * the tests exercise the exact code the server actions run — no HTTP, no
 * mocks, no test-only branches.
 */
import type { DB } from './db';

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'cancelled_seat_taken'
  | 'cancelled';

export type ErrorCode =
  | 'STUDENT_NOT_FOUND'
  | 'CLASS_NOT_FOUND'
  | 'BOOKING_NOT_FOUND'
  | 'ALREADY_BOOKED'
  | 'CLASS_FULL'
  | 'INVALID_STATE'
  | 'PAYMENT_DECLINED'
  | 'LOST_LAST_SEAT';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const err = (code: ErrorCode, message: string): Result<never> => ({ ok: false, code, message });

export interface Booking {
  id: number;
  student_id: number;
  trial_class_id: number;
  status: BookingStatus;
  seat_no: number | null;
  created_at: string;
  updated_at: string;
}

export interface TrialClass {
  id: number;
  subject: string;
  teacher: string;
  starts_at: string;
  capacity: number;
  price_cents: number;
}

export interface PaymentAttempt {
  id: number;
  booking_id: number;
  provider_ref: string;
  outcome: 'succeeded' | 'failed' | 'refunded';
  amount_cents: number;
  failure_reason: string | null;
  created_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/* ------------------------------------------------------------------ reads */

export function listStudents(db: DB) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.grade, p.name AS parent_name, p.id AS parent_id
         FROM students s JOIN parents p ON p.id = s.parent_id
        ORDER BY p.name, s.name`,
    )
    .all() as { id: number; name: string; grade: string; parent_name: string; parent_id: number }[];
}

/**
 * Classes with a live confirmed-seat count.
 *
 * `seats_left` is display data only. By the time it reaches a browser it is
 * already potentially stale — which is exactly why the seat claim in
 * `payBooking` re-derives it under a write lock instead of trusting it.
 */
export function listClasses(db: DB) {
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM bookings b
                WHERE b.trial_class_id = c.id AND b.status = 'confirmed') AS confirmed_count
         FROM trial_classes c
        ORDER BY c.starts_at`,
    )
    .all() as (TrialClass & { confirmed_count: number })[];
  return rows.map((c) => ({ ...c, seats_left: c.capacity - c.confirmed_count }));
}

export function getBooking(db: DB, id: number): Booking | undefined {
  return db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id) as Booking | undefined;
}

export function getBookingDetail(db: DB, id: number) {
  const row = db
    .prepare(
      `SELECT b.*, s.name AS student_name, c.subject, c.teacher, c.starts_at,
              c.capacity, c.price_cents
         FROM bookings b
         JOIN students s      ON s.id = b.student_id
         JOIN trial_classes c ON c.id = b.trial_class_id
        WHERE b.id = ?`,
    )
    .get(id) as
    | (Booking & {
        student_name: string;
        subject: string;
        teacher: string;
        starts_at: string;
        capacity: number;
        price_cents: number;
      })
    | undefined;
  if (!row) return undefined;

  const payments = db
    .prepare(`SELECT * FROM payment_attempts WHERE booking_id = ? ORDER BY id`)
    .all(id) as PaymentAttempt[];

  return { ...row, payments };
}

/**
 * The roster an admin or teacher relies on before class starts.
 *
 * CONFIRMED ONLY. A booking that is pending, failed, cancelled, or lost a seat
 * race is not on this list — that is the requirement "payment failure without
 * incorrectly adding the child to the confirmed roster", and it holds because
 * of the `status = 'confirmed'` filter plus the schema CHECK that a seat
 * exists if and only if the booking is confirmed.
 */
export function getRoster(db: DB, classId?: number) {
  const classes = (
    classId
      ? [db.prepare(`SELECT * FROM trial_classes WHERE id = ?`).get(classId)]
      : db.prepare(`SELECT * FROM trial_classes ORDER BY starts_at`).all()
  ).filter(Boolean) as TrialClass[];

  const seats = db.prepare(
    `SELECT b.id AS booking_id, b.seat_no, b.updated_at AS confirmed_at,
            s.name AS student_name, s.grade, p.name AS parent_name, p.email AS parent_email
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN parents  p ON p.id = s.parent_id
      WHERE b.trial_class_id = ? AND b.status = 'confirmed'
      ORDER BY b.seat_no`,
  );

  return classes.map((c) => {
    const students = seats.all(c.id) as {
      booking_id: number;
      seat_no: number;
      confirmed_at: string;
      student_name: string;
      grade: string;
      parent_name: string;
      parent_email: string;
    }[];
    return {
      class_id: c.id,
      subject: c.subject,
      teacher: c.teacher,
      starts_at: c.starts_at,
      capacity: c.capacity,
      confirmed_count: students.length,
      seats_left: c.capacity - students.length,
      students,
    };
  });
}

/* ----------------------------------------------------------------- writes */

function confirmedCount(db: DB, classId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings
        WHERE trial_class_id = ? AND status = 'confirmed'`,
    )
    .get(classId) as { n: number };
  return row.n;
}

function confirmedFor(db: DB, studentId: number, classId: number): Booking | undefined {
  return db
    .prepare(
      `SELECT * FROM bookings
        WHERE student_id = ? AND trial_class_id = ? AND status = 'confirmed'`,
    )
    .get(studentId, classId) as Booking | undefined;
}

/**
 * Lowest unoccupied seat in 1..capacity, or null if the class is full.
 *
 * Must only be called with the write lock held (inside `.immediate()`),
 * otherwise two callers can read the same free seat and both try to take it.
 */
function claimableSeat(db: DB, classId: number, capacity: number): number | null {
  const rows = db
    .prepare(
      `SELECT seat_no FROM bookings
        WHERE trial_class_id = ? AND status = 'confirmed'`,
    )
    .all(classId) as { seat_no: number }[];
  const taken = new Set(rows.map((r) => r.seat_no));
  for (let seat = 1; seat <= capacity; seat++) if (!taken.has(seat)) return seat;
  return null;
}

/**
 * Step 1 of the flow: a parent picks a child and a class.
 *
 * Creates a `pending_payment` booking. It does NOT hold a seat — see the
 * "Last-seat race" section of the README for why the seat is claimed at
 * payment time instead.
 *
 * The CLASS_FULL check here is a courtesy, not the safety net: it avoids
 * sending someone to a payment page for a class that is already visibly full.
 * The real guarantee lives in `payBooking`.
 */
export function createBooking(
  db: DB,
  input: { studentId: number; classId: number },
): Result<Booking> {
  const { studentId, classId } = input;

  const student = db.prepare(`SELECT id FROM students WHERE id = ?`).get(studentId);
  if (!student) return err('STUDENT_NOT_FOUND', `No student with id ${studentId}.`);

  const klass = db.prepare(`SELECT * FROM trial_classes WHERE id = ?`).get(classId) as
    | TrialClass
    | undefined;
  if (!klass) return err('CLASS_NOT_FOUND', `No trial class with id ${classId}.`);

  const run = db.transaction((): Result<Booking> => {
    if (confirmedFor(db, studentId, classId)) {
      return err(
        'ALREADY_BOOKED',
        'This child already has a confirmed booking for this trial class.',
      );
    }

    if (confirmedCount(db, classId) >= klass.capacity) {
      return err('CLASS_FULL', 'This trial class is full.');
    }

    // Re-submitting the same selection (double-click, browser back) reuses the
    // open attempt rather than littering the table with dead pending rows.
    const open = db
      .prepare(
        `SELECT * FROM bookings
          WHERE student_id = ? AND trial_class_id = ? AND status = 'pending_payment'
          ORDER BY id LIMIT 1`,
      )
      .get(studentId, classId) as Booking | undefined;
    if (open) return ok(open);

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO bookings (student_id, trial_class_id, status)
         VALUES (?, ?, 'pending_payment')`,
      )
      .run(studentId, classId);

    return ok(getBooking(db, Number(lastInsertRowid))!);
  });

  return run.immediate();
}

/** Stand-in for a payment provider. Deterministic, so the demo is reproducible. */
function mockCharge(simulate: 'success' | 'failure') {
  return simulate === 'success'
    ? { outcome: 'succeeded' as const, failureReason: null }
    : { outcome: 'failed' as const, failureReason: 'card_declined' };
}

/**
 * Step 2: charge, then claim a seat.
 *
 * The ordering here is the answer to the last-seat race:
 *
 *   1. charge OUTSIDE the transaction — a real provider call must not be held
 *      inside a database write lock
 *   2. inside ONE `BEGIN IMMEDIATE` transaction: record the attempt, re-check
 *      every precondition under the write lock, then claim a seat
 *
 * Because the transaction is IMMEDIATE, SQLite hands the write lock to exactly
 * one caller at a time, so "find a free seat and take it" is atomic. A caller
 * that arrives to find no seat left is refunded and parked in
 * `cancelled_seat_taken`; it never becomes confirmed.
 *
 * Every path that returns after a successful charge writes a `refunded`
 * attempt. Money and roster state move together, or not at all.
 */
export function payBooking(
  db: DB,
  input: { bookingId: number; simulate: 'success' | 'failure'; providerRef?: string },
): Result<Booking> {
  const { bookingId, simulate } = input;

  const booking = getBooking(db, bookingId);
  if (!booking) return err('BOOKING_NOT_FOUND', `No booking with id ${bookingId}.`);

  // Cheap pre-check so an already-settled booking is never charged again.
  // Re-asserted under the write lock below, which is the authoritative check.
  if (booking.status !== 'pending_payment') {
    return err('INVALID_STATE', `Booking is already ${booking.status}; nothing to pay.`);
  }

  const klass = db
    .prepare(`SELECT * FROM trial_classes WHERE id = ?`)
    .get(booking.trial_class_id) as TrialClass;

  const providerRef =
    input.providerRef ??
    `pay_${bookingId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const charge = mockCharge(simulate);

  const setStatus = db.prepare(
    `UPDATE bookings SET status = ?, seat_no = ?, updated_at = ${NOW} WHERE id = ?`,
  );
  const record = db.prepare(
    `INSERT INTO payment_attempts
       (booking_id, provider_ref, outcome, amount_cents, failure_reason)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const refund = (reason: string) =>
    record.run(bookingId, `${providerRef}_refund`, 'refunded', klass.price_cents, reason);

  const settle = db.transaction((): Result<Booking> => {
    record.run(bookingId, providerRef, charge.outcome, klass.price_cents, charge.failureReason);

    // Authoritative state check: another request may have settled this booking
    // between our pre-check and our acquiring the write lock.
    const current = getBooking(db, bookingId)!;
    if (current.status !== 'pending_payment') {
      if (charge.outcome === 'succeeded') refund('duplicate_settlement');
      return err('INVALID_STATE', `Booking is already ${current.status}; nothing to pay.`);
    }

    if (charge.outcome === 'failed') {
      // No seat is assigned, so the child cannot reach the confirmed roster.
      // The schema CHECK makes any other outcome literally un-writable.
      setStatus.run('payment_failed', null, bookingId);
      return err('PAYMENT_DECLINED', 'Payment was declined. No seat has been reserved.');
    }

    // Someone confirmed this child into this class while we were charging.
    if (confirmedFor(db, booking.student_id, booking.trial_class_id)) {
      refund('duplicate_booking');
      setStatus.run('cancelled', null, bookingId);
      return err(
        'ALREADY_BOOKED',
        'This child already has a confirmed booking for this trial class. Payment refunded.',
      );
    }

    const seat = claimableSeat(db, booking.trial_class_id, klass.capacity);
    if (seat === null) {
      // Lost the last-seat race. Refunded, and explicitly NOT confirmed.
      refund('class_full_at_capture');
      setStatus.run('cancelled_seat_taken', null, bookingId);
      return err(
        'LOST_LAST_SEAT',
        'The last seat was taken while your payment was processing. Payment refunded.',
      );
    }

    setStatus.run('confirmed', seat, bookingId);
    return ok(getBooking(db, bookingId)!);
  });

  return settle.immediate();
}
