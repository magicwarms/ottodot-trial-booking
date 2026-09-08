/**
 * Demo helper: another parent takes a seat, from a separate process.
 *
 * This exists so the last-seat race can be demonstrated by hand. Leave a
 * booking sitting on the payment page in the browser, run this, then press Pay
 * in the browser — the browser's payment will be refunded and parked in
 * `cancelled_seat_taken` rather than confirmed.
 *
 *   npm run take-seat          # class 2 (the class seeded with 3 of 4 seats taken)
 *   npm run take-seat -- 3     # a specific class id
 *   npm run take-seat -- 3 4   # a specific class id and student id
 *
 * It picks an eligible child automatically unless you name one, so there are no
 * ids to memorise.
 */
import { connect, DB_FILE } from '../lib/db';
import { createBooking, payBooking, getRoster } from '../lib/booking';

const classId = Number(process.argv[2] ?? 2);
const studentArg = process.argv[3] ? Number(process.argv[3]) : undefined;

const db = connect(DB_FILE);

const klass = db.prepare(`SELECT * FROM trial_classes WHERE id = ?`).get(classId) as
  | { id: number; subject: string; teacher: string }
  | undefined;

if (!klass) {
  console.error(`\nNo trial class with id ${classId}. Run "npm run seed" first.\n`);
  process.exit(1);
}

const before = getRoster(db, classId)[0];
console.log(`\nClass #${classId} — ${klass.subject} with ${klass.teacher}`);
console.log(`  before: ${before.confirmed_count}/${before.capacity} confirmed, ${before.seats_left} seat(s) left`);

if (before.seats_left === 0) {
  console.log('\nThis class is already full — nothing to take.\n');
  process.exit(0);
}

// Any child who is not already confirmed in this class can take a seat.
const student = (studentArg
  ? db.prepare(`SELECT id, name FROM students WHERE id = ?`).get(studentArg)
  : db
      .prepare(
        `SELECT s.id, s.name FROM students s
          WHERE NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.student_id = s.id
               AND b.trial_class_id = ?
               AND b.status = 'confirmed')
          ORDER BY s.id LIMIT 1`,
      )
      .get(classId)) as { id: number; name: string } | undefined;

if (!student) {
  console.error('\nNo eligible student found for this class.\n');
  process.exit(1);
}

const created = createBooking(db, { studentId: student.id, classId });
if (!created.ok) {
  console.error(`\n${student.name} could not book: ${created.code} — ${created.message}\n`);
  process.exit(1);
}

const paid = payBooking(db, { bookingId: created.value.id, simulate: 'success' });
const after = getRoster(db, classId)[0];

console.log(
  paid.ok
    ? `  ${student.name} paid and took seat ${paid.value.seat_no} (booking #${created.value.id})`
    : `  ${student.name} could not confirm: ${paid.code} — ${paid.message}`,
);
console.log(`  after:  ${after.confirmed_count}/${after.capacity} confirmed, ${after.seats_left} seat(s) left`);
console.log(
  after.seats_left === 0
    ? '\nThe class is now FULL. Go press Pay in the browser — that payment must not confirm.\n'
    : '\nRun this again to take another seat.\n',
);
