/**
 * The required technical scenario, step for step:
 *
 *   1. User A selects the last available slot and moves to payment.
 *   2. User B selects the same slot.
 *   3. User B completes payment first and confirms the booking.
 *   4. User A then tries to complete payment.
 *
 * "At most one user can end up with a confirmed booking for the last available
 * seat."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, confirm, confirmedCount, CAPACITY } from './helpers';
import { createBooking, payBooking, getBooking, getRoster } from '../lib/booking';

test('last-seat race: exactly one of A and B ends up confirmed', () => {
  const { db, students, classId } = fixture();

  // Three of four seats are already taken: one seat remains.
  for (let i = 0; i < CAPACITY - 1; i++) confirm(db, students[i], classId);
  assert.equal(getRoster(db, classId)[0].seats_left, 1);

  const [, , , userA, userB] = students;

  // 1. User A selects the last slot and moves to payment.
  const a = createBooking(db, { studentId: userA, classId });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.value.status, 'pending_payment');
  assert.equal(a.value.seat_no, null, 'selecting must not reserve a seat');

  // 2. User B selects the same slot. Both are pending; neither holds a seat.
  const b = createBooking(db, { studentId: userB, classId });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.value.seat_no, null);

  // 3. User B completes payment first and confirms.
  const bPaid = payBooking(db, { bookingId: b.value.id, simulate: 'success' });
  assert.equal(bPaid.ok, true);
  assert.equal(bPaid.ok === true && bPaid.value.status, 'confirmed');
  assert.equal(bPaid.ok === true && bPaid.value.seat_no, CAPACITY);

  // 4. User A then tries to complete payment.
  const aPaid = payBooking(db, { bookingId: a.value.id, simulate: 'success' });
  assert.equal(aPaid.ok, false, 'A must not also be confirmed');
  assert.equal(aPaid.ok === false && aPaid.code, 'LOST_LAST_SEAT');

  // The invariant the brief asks for.
  assert.equal(confirmedCount(db, classId), CAPACITY);

  const aAfter = getBooking(db, a.value.id)!;
  assert.equal(aAfter.status, 'cancelled_seat_taken');
  assert.equal(aAfter.seat_no, null);

  // A was charged before the seat could be claimed, so A must be made whole.
  const refunds = db
    .prepare(
      `SELECT * FROM payment_attempts WHERE booking_id = ? AND outcome = 'refunded'`,
    )
    .all(a.value.id) as { failure_reason: string }[];
  assert.equal(refunds.length, 1, 'the losing user must be refunded');
  assert.equal(refunds[0].failure_reason, 'class_full_at_capture');

  // And A is not on the roster the teacher will read.
  const roster = getRoster(db, classId)[0];
  assert.equal(roster.students.length, CAPACITY);
  assert.equal(
    roster.students.some((s) => s.student_name === `Student ${students.indexOf(userA) + 1}`),
    false,
  );
});

test('last-seat race: A wins if A pays first (the scenario is symmetric)', () => {
  const { db, students, classId } = fixture();
  for (let i = 0; i < CAPACITY - 1; i++) confirm(db, students[i], classId);
  const [, , , userA, userB] = students;

  const a = createBooking(db, { studentId: userA, classId });
  const b = createBooking(db, { studentId: userB, classId });
  if (!a.ok || !b.ok) throw new Error('setup');

  const aPaid = payBooking(db, { bookingId: a.value.id, simulate: 'success' });
  const bPaid = payBooking(db, { bookingId: b.value.id, simulate: 'success' });

  assert.equal(aPaid.ok, true);
  assert.equal(bPaid.ok, false);
  assert.equal(bPaid.ok === false && bPaid.code, 'LOST_LAST_SEAT');
  assert.equal(confirmedCount(db, classId), CAPACITY);
});

test('last-seat race: a losing payment that also FAILS is not refunded twice', () => {
  const { db, students, classId } = fixture();
  for (let i = 0; i < CAPACITY - 1; i++) confirm(db, students[i], classId);
  const [, , , userA, userB] = students;

  const a = createBooking(db, { studentId: userA, classId });
  const b = createBooking(db, { studentId: userB, classId });
  if (!a.ok || !b.ok) throw new Error('setup');

  payBooking(db, { bookingId: b.value.id, simulate: 'success' });

  // A's card is declined anyway. There is nothing to refund.
  const aPaid = payBooking(db, { bookingId: a.value.id, simulate: 'failure' });
  assert.equal(aPaid.ok === false && aPaid.code, 'PAYMENT_DECLINED');
  assert.equal(getBooking(db, a.value.id)!.status, 'payment_failed');

  const refunds = db
    .prepare(`SELECT COUNT(*) n FROM payment_attempts WHERE booking_id = ? AND outcome = 'refunded'`)
    .get(a.value.id) as { n: number };
  assert.equal(refunds.n, 0, 'nothing was captured, so nothing is refunded');
  assert.equal(confirmedCount(db, classId), CAPACITY);
});

test('last-seat race: a cancelled seat is released and re-usable', () => {
  const { db, students, classId } = fixture();
  for (let i = 0; i < CAPACITY; i++) confirm(db, students[i], classId);
  assert.equal(confirmedCount(db, classId), CAPACITY);

  // A confirmed booking is cancelled: the CHECK forces seat_no to be released.
  db.prepare(`UPDATE bookings SET status = 'cancelled', seat_no = NULL WHERE id = ?`).run(
    (db.prepare(`SELECT id FROM bookings WHERE seat_no = 2 AND trial_class_id = ?`).get(classId) as {
      id: number;
    }).id,
  );

  const next = createBooking(db, { studentId: students[CAPACITY], classId });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  const paid = payBooking(db, { bookingId: next.value.id, simulate: 'success' });
  assert.equal(paid.ok === true && paid.value.seat_no, 2, 'the freed seat is reused');
  assert.equal(confirmedCount(db, classId), CAPACITY);
});
