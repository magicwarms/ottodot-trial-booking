import { createSchema } from '../lib/db';
import { createBooking, payBooking } from '../lib/booking';
import type { DB } from '../lib/db';

export const CAPACITY = 4;

/** Fresh database with one parent, eight students, and one 4-seat class. */
export function fixture(file = ':memory:') {
  const db = createSchema(file);
  const parentId = Number(
    db.prepare(`INSERT INTO parents (name, email) VALUES (?, ?)`).run('Parent', 'p@example.com')
      .lastInsertRowid,
  );
  const insertStudent = db.prepare(
    `INSERT INTO students (parent_id, name, grade) VALUES (?, ?, 'P4')`,
  );
  const students = Array.from({ length: 16 }, (_, i) =>
    Number(insertStudent.run(parentId, `Student ${i + 1}`).lastInsertRowid),
  );
  const classId = Number(
    db
      .prepare(
        `INSERT INTO trial_classes (subject, teacher, starts_at, capacity, price_cents)
         VALUES ('Math', 'Mr Chen', '2026-09-13T06:00:00Z', ?, 3900)`,
      )
      .run(CAPACITY).lastInsertRowid,
  );
  return { db, students, classId, parentId };
}

/** Book + pay successfully, or throw. Used to set up a given seat count. */
export function confirm(db: DB, studentId: number, classId: number) {
  const created = createBooking(db, { studentId, classId });
  if (!created.ok) throw new Error(`setup createBooking: ${created.code}`);
  const paid = payBooking(db, { bookingId: created.value.id, simulate: 'success' });
  if (!paid.ok) throw new Error(`setup payBooking: ${paid.code}`);
  return paid.value;
}

export function confirmedCount(db: DB, classId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) n FROM bookings WHERE trial_class_id = ? AND status = 'confirmed'`)
      .get(classId) as { n: number }
  ).n;
}
