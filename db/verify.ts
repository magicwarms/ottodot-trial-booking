/**
 * Independent check of the live database file.
 *
 * The tests prove the code upholds the invariants. This proves the *data*
 * does, by querying for violations directly — the check you would run against
 * production after an incident, not the one you run in CI.
 */
import { connect, DB_FILE } from '../lib/db';

const db = connect(DB_FILE);

const checks: { name: string; sql: string }[] = [
  {
    name: 'no class has more than its capacity confirmed',
    sql: `SELECT c.id, COUNT(b.id) n FROM trial_classes c
          JOIN bookings b ON b.trial_class_id = c.id AND b.status = 'confirmed'
          GROUP BY c.id HAVING n > c.capacity`,
  },
  {
    name: 'no child is confirmed twice in the same class',
    sql: `SELECT student_id, trial_class_id, COUNT(*) n FROM bookings
          WHERE status = 'confirmed'
          GROUP BY student_id, trial_class_id HAVING n > 1`,
  },
  {
    name: 'no two confirmed bookings share a seat',
    sql: `SELECT trial_class_id, seat_no, COUNT(*) n FROM bookings
          WHERE status = 'confirmed'
          GROUP BY trial_class_id, seat_no HAVING n > 1`,
  },
  {
    name: 'every confirmed booking holds a seat in 1..4',
    sql: `SELECT id FROM bookings
          WHERE status = 'confirmed' AND (seat_no IS NULL OR seat_no NOT BETWEEN 1 AND 4)`,
  },
  {
    name: 'no unconfirmed booking holds a seat',
    sql: `SELECT id FROM bookings WHERE status != 'confirmed' AND seat_no IS NOT NULL`,
  },
  {
    name: 'no failed payment left a child on the roster',
    sql: `SELECT b.id FROM bookings b
          WHERE b.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM payment_attempts p
                             WHERE p.booking_id = b.id AND p.outcome = 'succeeded')`,
  },
  {
    name: 'every lost/cancelled paid booking was refunded',
    sql: `SELECT b.id FROM bookings b
          WHERE b.status IN ('cancelled_seat_taken','cancelled')
            AND EXISTS (SELECT 1 FROM payment_attempts p
                         WHERE p.booking_id = b.id AND p.outcome = 'succeeded')
            AND NOT EXISTS (SELECT 1 FROM payment_attempts p
                             WHERE p.booking_id = b.id AND p.outcome = 'refunded')`,
  },
];

let failed = 0;
console.log(`\nVerifying ${DB_FILE}\n`);
for (const { name, sql } of checks) {
  const violations = db.prepare(sql).all();
  const bad = violations.length > 0;
  if (bad) failed++;
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${name}${bad ? `  -> ${JSON.stringify(violations)}` : ''}`);
}

const totals = db
  .prepare(
    `SELECT status, COUNT(*) n FROM bookings GROUP BY status ORDER BY status`,
  )
  .all() as { status: string; n: number }[];
console.log('\nBookings by status');
for (const t of totals) console.log(`  ${t.status.padEnd(24)} ${t.n}`);

console.log(failed === 0 ? '\nAll invariants hold.\n' : `\n${failed} invariant(s) VIOLATED.\n`);
process.exit(failed === 0 ? 0 : 1);
