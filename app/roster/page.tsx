import { getDb } from '../../lib/db';
import { getRoster } from '../../lib/booking';

export const dynamic = 'force-dynamic';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';

export default async function RosterPage() {
  const roster = getRoster(getDb());

  return (
    <>
      <h1>Trial class roster</h1>
      <p className="sub">
        Confirmed students only. Pending, declined, and cancelled bookings never appear here.
        Same data as <code>GET /api/roster</code>.
      </p>

      {roster.map((c) => (
        <section className="panel" key={c.class_id}>
          <h2 style={{ margin: '0 0 4px' }}>
            {c.subject} — {c.teacher}
          </h2>
          <p className="sub" style={{ marginBottom: 14 }}>
            {when(c.starts_at)} · {c.confirmed_count}/{c.capacity} confirmed
            {c.seats_left === 0 ? ' · full' : ` · ${c.seats_left} seat(s) left`}
          </p>

          {c.students.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>No students confirmed yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Seat</th>
                  <th>Student</th>
                  <th>Grade</th>
                  <th>Parent</th>
                  <th>Contact</th>
                  <th>Booking</th>
                </tr>
              </thead>
              <tbody>
                {c.students.map((s) => (
                  <tr key={s.booking_id}>
                    <td className="seats">{s.seat_no}</td>
                    <td>{s.student_name}</td>
                    <td>{s.grade}</td>
                    <td>{s.parent_name}</td>
                    <td>{s.parent_email}</td>
                    <td>#{s.booking_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </>
  );
}
