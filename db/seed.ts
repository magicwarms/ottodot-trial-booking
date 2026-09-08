/**
 * Rebuilds trial-booking.db from scratch with a small synthetic dataset.
 *
 * Bookings are created by calling the real createBooking/payBooking functions
 * rather than by hand-writing rows. Two reasons: the seed cannot drift from
 * the invariants, and running the seed is itself a smoke test of the flow.
 */
import { existsSync, rmSync } from 'node:fs';
import { createSchema, DB_FILE } from '../lib/db';
import { createBooking, payBooking, listClasses } from '../lib/booking';

for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  if (existsSync(f)) rmSync(f);
}
const db = createSchema(DB_FILE);

const parent = db.prepare(`INSERT INTO parents (name, email) VALUES (?, ?)`);
const student = db.prepare(`INSERT INTO students (parent_id, name, grade) VALUES (?, ?, ?)`);
const klass = db.prepare(
  `INSERT INTO trial_classes (subject, teacher, starts_at, capacity, price_cents)
   VALUES (?, ?, ?, 4, ?)`,
);

const siti = Number(parent.run('Siti Rahayu', 'siti@example.com').lastInsertRowid);
const daniel = Number(parent.run('Daniel Tan', 'daniel@example.com').lastInsertRowid);
const priya = Number(parent.run('Priya Nair', 'priya@example.com').lastInsertRowid);

const aisha = Number(student.run(siti, 'Aisha Rahayu', 'P4').lastInsertRowid);
const rafi = Number(student.run(siti, 'Rafi Rahayu', 'P3').lastInsertRowid);
const ethan = Number(student.run(daniel, 'Ethan Tan', 'P4').lastInsertRowid);
const mei = Number(student.run(daniel, 'Mei Tan', 'P5').lastInsertRowid);
const arjun = Number(student.run(priya, 'Arjun Nair', 'P4').lastInsertRowid);

const SEATS_FREE = Number(
  klass.run('Science', 'Ms Lim', '2026-09-13T02:00:00Z', 3900).lastInsertRowid,
);
const LAST_SEAT = Number(
  klass.run('Math', 'Mr Chen', '2026-09-13T06:00:00Z', 3900).lastInsertRowid,
);
const FULL = Number(
  klass.run('Science', 'Ms Lim', '2026-09-14T02:00:00Z', 3900).lastInsertRowid,
);
const EMPTY = Number(
  klass.run('Math', 'Ms Devi', '2026-09-14T06:00:00Z', 4500).lastInsertRowid,
);

/** Book and pay in one step, asserting the outcome the seed intends. */
function seedBooking(studentId: number, classId: number, simulate: 'success' | 'failure') {
  const created = createBooking(db, { studentId, classId });
  if (!created.ok) throw new Error(`seed: createBooking failed: ${created.code} ${created.message}`);
  const paid = payBooking(db, { bookingId: created.value.id, simulate });
  if (simulate === 'success' && !paid.ok) {
    throw new Error(`seed: expected confirm, got ${paid.code}`);
  }
  return created.value.id;
}

// Case 1 — a class with available seats (1 of 4 taken).
seedBooking(aisha, SEATS_FREE, 'success');

// Case 2 — a class with EXACTLY 3 confirmed students. One seat left; this is
// the class the last-seat race demo and tests target.
seedBooking(aisha, LAST_SEAT, 'success');
seedBooking(ethan, LAST_SEAT, 'success');
seedBooking(mei, LAST_SEAT, 'success');

// Case 3 — a payment failure. Rafi's card is declined for the last-seat class.
// He must NOT appear on the roster and must NOT be holding the free seat.
const failedBookingId = seedBooking(rafi, LAST_SEAT, 'failure');

// Case 4 — a class already at capacity, to demo the overbooking rejection.
seedBooking(aisha, FULL, 'success');
seedBooking(rafi, FULL, 'success');
seedBooking(ethan, FULL, 'success');
seedBooking(mei, FULL, 'success');

// Case 5 — a duplicate booking attempt for the same child and class.
// Aisha is already confirmed in SEATS_FREE, so this is rejected on the spot.
const dup = createBooking(db, { studentId: aisha, classId: SEATS_FREE });
const dupOutcome = dup.ok ? 'UNEXPECTEDLY ALLOWED' : `${dup.code} — ${dup.message}`;

const line = (label: string, body: string) => console.log(`  ${label.padEnd(34)} ${body}`);

console.log(`\nSeeded ${DB_FILE}\n`);
console.log('Classes');
for (const c of listClasses(db)) {
  const tag =
    c.id === LAST_SEAT ? '  <- exactly 3 confirmed, 1 seat left' : c.seats_left === 0 ? '  <- full' : '';
  line(
    `#${c.id} ${c.subject} / ${c.teacher}`,
    `${c.confirmed_count}/${c.capacity} confirmed  ${c.starts_at}${tag}`,
  );
}

console.log('\nRequired edge cases');
line('class with available seats', `#${SEATS_FREE} (1/4) and #${EMPTY} (0/4)`);
line('class with exactly 3 confirmed', `#${LAST_SEAT} — 1 seat left`);
line('duplicate booking attempt', dupOutcome);
line('payment failure', `booking #${failedBookingId} (Rafi, class #${LAST_SEAT}) -> payment_failed`);

console.log('\nStudents');
line('ids', `Aisha=${aisha} Rafi=${rafi} Ethan=${ethan} Mei=${mei} Arjun=${arjun}`);
line('Arjun', 'no bookings yet — use him for the happy-path demo');
console.log('');
