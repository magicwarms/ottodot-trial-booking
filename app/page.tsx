import { getDb } from '../lib/db';
import { listStudents, listClasses } from '../lib/booking';
import { createBookingAction } from './actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const db = getDb();
  const students = listStudents(db);
  const classes = listClasses(db);

  return (
    <>
      <h1>Book a trial class</h1>
      <p className="sub">
        Pick a child and an available class. Seats are confirmed at payment, not at selection.
      </p>

      {error && <div className="notice">{error}</div>}

      <form action={createBookingAction}>
        <section className="panel">
          <label htmlFor="studentId">Child</label>
          <select id="studentId" name="studentId" defaultValue={students[0]?.id} required>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.grade} (parent: {s.parent_name})
              </option>
            ))}
          </select>
        </section>

        <h2>Available trial classes</h2>
        <section className="panel">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Class</th>
                <th>Teacher</th>
                <th>Starts</th>
                <th>Seats</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c, i) => {
                const full = c.seats_left <= 0;
                return (
                  <tr key={c.id}>
                    <td>
                      <input
                        type="radio"
                        name="classId"
                        value={c.id}
                        id={`class-${c.id}`}
                        disabled={full}
                        defaultChecked={!full && classes.slice(0, i).every((p) => p.seats_left <= 0)}
                        required
                      />
                    </td>
                    <td>
                      <label htmlFor={`class-${c.id}`} style={{ textTransform: 'none', fontSize: 14, letterSpacing: 0, color: 'inherit', margin: 0 }}>
                        {c.subject}
                      </label>
                    </td>
                    <td>{c.teacher}</td>
                    <td>{when(c.starts_at)}</td>
                    <td className="seats">
                      {full ? (
                        <span className="full">FULL</span>
                      ) : (
                        `${c.confirmed_count}/${c.capacity} — ${c.seats_left} left`
                      )}
                    </td>
                    <td>{money(c.price_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <button className="primary" type="submit">
          Continue to payment
        </button>
      </form>

      <p className="sub" style={{ marginTop: 24, fontSize: 13 }}>
        Seat counts shown here are advisory — they can be stale by the time you press the button.
        The authoritative check runs inside the payment transaction.
      </p>
    </>
  );
}
