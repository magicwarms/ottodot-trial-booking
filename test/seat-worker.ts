/**
 * One contender in the concurrency test. Opens its OWN SQLite connection —
 * separate handle, separate write-lock claimant — waits on a shared start
 * barrier, then tries to pay. Real threads, real lock contention.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { connect } from '../lib/db';
import { payBooking } from '../lib/booking';

const { dbFile, bookingId, startAt } = workerData as {
  dbFile: string;
  bookingId: number;
  startAt: number;
};

const db = connect(dbFile);

// Spin until the agreed instant so every worker attacks at once.
while (Date.now() < startAt) {
  /* busy-wait: a timer would let the OS stagger us */
}

const result = payBooking(db, { bookingId, simulate: 'success' });
db.close();

parentPort!.postMessage(
  result.ok
    ? { ok: true, seat: result.value.seat_no }
    : { ok: false, code: result.code },
);
