import { notFound } from 'next/navigation';
import { getDb } from '../../../lib/db';
import { getBookingDetail } from '../../../lib/booking';
import { payBookingAction } from '../../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const EXPLAIN: Record<string, string> = {
  pending_payment: 'No seat is held yet. The seat is claimed when payment succeeds.',
  confirmed: 'Seat claimed. The child is on the class roster.',
  payment_failed: 'The payment was declined. No seat was reserved and the child is not on the roster.',
  cancelled_seat_taken:
    'The last seat was claimed by someone else while this payment was processing. The payment was refunded.',
  cancelled: 'This booking was cancelled and any payment was refunded.',
};

export default async function BookingStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const booking = getBookingDetail(getDb(), Number(id));
  if (!booking) notFound();

  const payable = booking.status === 'pending_payment';

  return (
    <>
      <h1>Booking #{booking.id}</h1>
      <p className="sub">
        {booking.student_name} — {booking.subject} with {booking.teacher}
      </p>

      {error && <div className="notice">{error}</div>}

      <section className="panel">
        <table>
          <tbody>
            <tr>
              <th style={{ width: 160 }}>Status</th>
              <td>
                <span className={`badge ${booking.status}`}>{booking.status}</span>
              </td>
            </tr>
            <tr>
              <th>Seat</th>
              <td>
                {booking.seat_no === null
                  ? '— none held —'
                  : `Seat ${booking.seat_no} of ${booking.capacity}`}
              </td>
            </tr>
            <tr>
              <th>Amount</th>
              <td>{money(booking.price_cents)}</td>
            </tr>
            <tr>
              <th>What this means</th>
              <td>{EXPLAIN[booking.status]}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {payable && (
        <>
          <h2>Mock payment</h2>
          <section className="panel">
            <form action={payBookingAction}>
              <input type="hidden" name="bookingId" value={booking.id} />
              <div className="row">
                <div>
                  <label htmlFor="simulate">Simulated provider result</label>
                  <select id="simulate" name="simulate" defaultValue="success">
                    <option value="success">Payment succeeds</option>
                    <option value="failure">Payment is declined</option>
                  </select>
                </div>
                <button className="primary" type="submit">
                  Pay {money(booking.price_cents)}
                </button>
              </div>
            </form>
          </section>
        </>
      )}

      {!payable && booking.status !== 'confirmed' && (
        <p>
          <a href="/">Book again</a> — a failed or cancelled attempt never blocks a retry.
        </p>
      )}

      <h2>Payment attempts</h2>
      <section className="panel">
        {booking.payments.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>No payment attempted yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Amount</th>
                <th>Reason</th>
                <th>Provider ref</th>
                <th>At</th>
              </tr>
            </thead>
            <tbody>
              {booking.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.outcome}</td>
                  <td>{money(p.amount_cents)}</td>
                  <td>{p.failure_reason ?? '—'}</td>
                  <td>
                    <code>{p.provider_ref}</code>
                  </td>
                  <td>{p.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
