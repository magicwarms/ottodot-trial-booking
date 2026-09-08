/**
 * The four rules the brief says the system "must prevent or handle", minus the
 * last-seat race, which has its own file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, confirm, confirmedCount, CAPACITY } from './helpers';
import { createBooking, payBooking, getBooking, getRoster } from '../lib/booking';

test('duplicate: the same child cannot be confirmed twice into the same class', () => {
  const { db, students, classId } = fixture();
  confirm(db, students[0], classId);

  const again = createBooking(db, { studentId: students[0], classId });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.code, 'ALREADY_BOOKED');
  assert.equal(confirmedCount(db, classId), 1);
});

test('duplicate: the database rejects a second confirmed row even if app logic is bypassed', () => {
  const { db, students, classId } = fixture();
  const first = confirm(db, students[0], classId);

  // Write directly, as a future endpoint or a migration script might.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (student_id, trial_class_id, status, seat_no)
           VALUES (?, ?, 'confirmed', ?)`,
        )
        .run(students[0], classId, first.seat_no === 1 ? 2 : 1),
    /UNIQUE constraint failed/,
  );
});

test('overbooking: a 5th student cannot be confirmed into a 4-seat class', () => {
  const { db, students, classId } = fixture();
  for (let i = 0; i < CAPACITY; i++) confirm(db, students[i], classId);
  assert.equal(confirmedCount(db, classId), CAPACITY);

  const fifth = createBooking(db, { studentId: students[CAPACITY], classId });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.ok === false && fifth.code, 'CLASS_FULL');
  assert.equal(confirmedCount(db, classId), CAPACITY);
});

test('overbooking: the database rejects a 5th confirmed row (seat space is 1..4)', () => {
  const { db, students, classId } = fixture();
  for (let i = 0; i < CAPACITY; i++) confirm(db, students[i], classId);

  // Seat 5 violates the CHECK; reusing seat 1 violates the unique index.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (student_id, trial_class_id, status, seat_no)
           VALUES (?, ?, 'confirmed', 5)`,
        )
        .run(students[CAPACITY], classId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (student_id, trial_class_id, status, seat_no)
           VALUES (?, ?, 'confirmed', 1)`,
        )
        .run(students[CAPACITY], classId),
    /UNIQUE constraint failed/,
  );
});

test('payment failure: the child is not added to the confirmed roster', () => {
  const { db, students, classId } = fixture();
  const created = createBooking(db, { studentId: students[0], classId });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const paid = payBooking(db, { bookingId: created.value.id, simulate: 'failure' });
  assert.equal(paid.ok, false);
  assert.equal(paid.ok === false && paid.code, 'PAYMENT_DECLINED');

  const after = getBooking(db, created.value.id)!;
  assert.equal(after.status, 'payment_failed');
  assert.equal(after.seat_no, null, 'a failed payment must not hold a seat');

  const roster = getRoster(db, classId)[0];
  assert.equal(roster.confirmed_count, 0);
  assert.equal(roster.students.length, 0);
  assert.equal(roster.seats_left, CAPACITY);

  const attempt = db
    .prepare(`SELECT * FROM payment_attempts WHERE booking_id = ?`)
    .get(created.value.id) as { outcome: string; failure_reason: string };
  assert.equal(attempt.outcome, 'failed');
  assert.equal(attempt.failure_reason, 'card_declined');
});

test('payment failure: a confirmed booking can never exist without a seat', () => {
  const { db, students, classId } = fixture();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (student_id, trial_class_id, status, seat_no)
           VALUES (?, ?, 'confirmed', NULL)`,
        )
        .run(students[0], classId),
    /CHECK constraint failed/,
  );
});

test('retry: after a declined payment the parent can book again and succeed', () => {
  const { db, students, classId } = fixture();
  const first = createBooking(db, { studentId: students[0], classId });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  payBooking(db, { bookingId: first.value.id, simulate: 'failure' });

  const retry = createBooking(db, { studentId: students[0], classId });
  assert.equal(retry.ok, true, 'a failed attempt must not block a retry');
  if (!retry.ok) return;
  assert.notEqual(retry.value.id, first.value.id);

  const paid = payBooking(db, { bookingId: retry.value.id, simulate: 'success' });
  assert.equal(paid.ok, true);
  assert.equal(confirmedCount(db, classId), 1);
});

test('idempotency: paying the same booking twice confirms once and charges once', () => {
  const { db, students, classId } = fixture();
  const created = createBooking(db, { studentId: students[0], classId });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const first = payBooking(db, { bookingId: created.value.id, simulate: 'success' });
  const second = payBooking(db, { bookingId: created.value.id, simulate: 'success' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.code, 'INVALID_STATE');

  const charges = db
    .prepare(
      `SELECT COUNT(*) n FROM payment_attempts
        WHERE booking_id = ? AND outcome = 'succeeded'`,
    )
    .get(created.value.id) as { n: number };
  assert.equal(charges.n, 1, 'the parent must not be charged twice');
  assert.equal(confirmedCount(db, classId), 1);
});

test('resubmitting the same selection reuses the open booking', () => {
  const { db, students, classId } = fixture();
  const a = createBooking(db, { studentId: students[0], classId });
  const b = createBooking(db, { studentId: students[0], classId });
  assert.equal(a.ok && b.ok && a.value.id === b.value.id, true);
});

test('roster shows confirmed students only, with seats 1..4', () => {
  const { db, students, classId } = fixture();
  for (let i = 0; i < 3; i++) confirm(db, students[i], classId);

  // Noise the roster must ignore: one pending, one failed.
  createBooking(db, { studentId: students[4], classId });
  const failing = createBooking(db, { studentId: students[5], classId });
  if (failing.ok) payBooking(db, { bookingId: failing.value.id, simulate: 'failure' });

  const roster = getRoster(db, classId)[0];
  assert.equal(roster.confirmed_count, 3);
  assert.equal(roster.seats_left, 1);
  assert.deepEqual(
    roster.students.map((s) => s.seat_no),
    [1, 2, 3],
  );
});
