/**
 * The last-seat race under genuine parallelism.
 *
 * The scenario test in race.test.ts pins down the ordering the brief
 * describes. This one removes the ordering: N worker threads, each with its
 * own database connection, all try to pay at the same instant. The invariant
 * must hold without anyone taking turns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, confirm, confirmedCount, CAPACITY } from './helpers';
import { createBooking, getRoster } from '../lib/booking';

const WORKER = fileURLToPath(new URL('./seat-worker.mjs', import.meta.url));

type WorkerResult = { ok: true; seat: number } | { ok: false; code: string };

function stampede(dbFile: string, bookingIds: number[]): Promise<WorkerResult[]> {
  const startAt = Date.now() + 250; // give every thread time to boot and spin
  return Promise.all(
    bookingIds.map(
      (bookingId) =>
        new Promise<WorkerResult>((resolve, reject) => {
          const w = new Worker(WORKER, {
            workerData: { dbFile, bookingId, startAt },
          });
          w.once('message', resolve);
          w.once('error', reject);
        }),
    ),
  );
}

/** Temp directory holding a real database file; workers need a file, not :memory:. */
function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ottodot-'));
  return { dir, file: join(dir, 'race.db') };
}

test('8 threads racing for 1 seat: exactly one wins, seven are refunded', async (t) => {
  const { dir, file } = tempDbFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { db, students, classId } = fixture(file);
  for (let i = 0; i < CAPACITY - 1; i++) confirm(db, students[i], classId);
  assert.equal(getRoster(db, classId)[0].seats_left, 1);

  const contenders = students.slice(CAPACITY - 1, CAPACITY - 1 + 8);
  const bookingIds = contenders.map((studentId) => {
    const r = createBooking(db, { studentId, classId });
    if (!r.ok) throw new Error(`setup: ${r.code}`);
    return r.value.id;
  });
  assert.equal(bookingIds.length, 8);

  const results = await stampede(file, bookingIds);

  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok) as { ok: false; code: string }[];

  assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}`);
  assert.equal(losers.length, 7);
  assert.deepEqual([...new Set(losers.map((l) => l.code))], ['LOST_LAST_SEAT']);

  assert.equal(confirmedCount(db, classId), CAPACITY);

  const refunds = (
    db
      .prepare(`SELECT COUNT(*) n FROM payment_attempts WHERE outcome = 'refunded'`)
      .get() as { n: number }
  ).n;
  assert.equal(refunds, 7, 'every loser is refunded');
  db.close();
});

test('12 threads racing for an empty class: exactly 4 win, seats are 1..4', async (t) => {
  const { dir, file } = tempDbFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { db, students, classId } = fixture(file);
  const bookingIds = students.slice(0, 12).map((studentId) => {
    const r = createBooking(db, { studentId, classId });
    if (!r.ok) throw new Error(`setup: ${r.code}`);
    return r.value.id;
  });

  const results = await stampede(file, bookingIds);
  const winners = results.filter((r) => r.ok) as { ok: true; seat: number }[];

  assert.equal(winners.length, CAPACITY, `expected ${CAPACITY} winners, got ${winners.length}`);
  assert.deepEqual(winners.map((w) => w.seat).sort(), [1, 2, 3, 4]);
  assert.equal(confirmedCount(db, classId), CAPACITY);

  const roster = getRoster(db, classId)[0];
  assert.equal(roster.confirmed_count, CAPACITY);
  assert.equal(roster.seats_left, 0);
  db.close();
});
