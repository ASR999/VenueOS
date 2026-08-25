import { useCallback, useEffect, useState } from 'react';
import { api, getUser, clearSession } from './api.js';
import EventList from './components/EventList.jsx';
import SeatGrid from './components/SeatGrid.jsx';
import CheckoutPanel from './components/CheckoutPanel.jsx';
import AuthPanel from './components/AuthPanel.jsx';

export default function App() {
  const [user, setUser] = useState(getUser());
  const [events, setEvents] = useState(null);
  const [event, setEvent] = useState(null); // selected event
  const [seats, setSeats] = useState([]);
  const [hold, setHold] = useState(null); // { seatId, label, priceCents, expiresAt }
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/catalog/events')
      .then(setEvents)
      .catch((e) => setError(`Could not load events: ${e.message}`));
  }, []);

  const refreshSeats = useCallback(async (eventId) => {
    const data = await api(`/booking/events/${eventId}/seats`);
    setSeats(data.seats);
    return data.seats;
  }, []);

  // Poll while looking at a seat map so other users' holds/bookings show up.
  useEffect(() => {
    if (!event || confirmation) return;
    refreshSeats(event._id).catch(() => {});
    const t = setInterval(() => refreshSeats(event._id).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [event, confirmation, refreshSeats]);

  async function handleSeatClick(seat) {
    setError(null);
    if (hold && hold.seatId === seat.id) return;
    try {
      setBusy(true);
      // Switching seats: release the previous hold first.
      if (hold) await releaseHold(hold, true);
      const h = await api('/booking/holds', {
        method: 'POST',
        body: JSON.stringify({ eventId: event._id, seatId: seat.id }),
      });
      setHold({ seatId: seat.id, label: seat.label, priceCents: seat.priceCents, expiresAt: h.expiresAt });
      await refreshSeats(event._id);
    } catch (e) {
      setError(e.status === 409 ? `Seat ${seat.label} was just taken — pick another.` : e.message);
    } finally {
      setBusy(false);
    }
  }

  async function releaseHold(h, silent = false) {
    try {
      await api('/booking/holds', {
        method: 'DELETE',
        body: JSON.stringify({ eventId: event._id, seatId: h.seatId }),
      });
    } catch (e) {
      if (!silent) setError(e.message);
    }
    setHold(null);
  }

  async function handlePay(simulateFailure) {
    setError(null);
    setBusy(true);
    try {
      const b = await api('/booking/bookings', {
        method: 'POST',
        body: JSON.stringify({
          eventId: event._id,
          seatId: hold.seatId,
          simulatePaymentFailure: simulateFailure || undefined,
        }),
      });
      setConfirmation({ ...b, eventName: event.name });
      setHold(null);
    } catch (e) {
      if (e.status === 402) setError(`Payment failed — seat ${hold.label} was released.`);
      else if (e.status === 502) setError('Payment status unknown — it will be resolved automatically. Check back soon.');
      else setError(e.message);
      setHold(null);
      refreshSeats(event._id).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    clearSession();
    setUser(null);
    setEvent(null);
    setHold(null);
    setConfirmation(null);
    setError(null);
  }

  // Any 401 means the stored token is no longer good - api() has already
  // cleared it, so the UI has to stop pretending we are signed in.
  useEffect(() => {
    if (error && /token|authentication/i.test(error)) setUser(null);
  }, [error]);

  function backToEvents() {
    if (hold) releaseHold(hold, true);
    setEvent(null);
    setConfirmation(null);
    setError(null);
  }

  if (!user) {
    return (
      <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
        <h1 style={{ margin: 0 }}>🎟️ TicketHub</h1>
        <AuthPanel onAuthenticated={setUser} />
      </main>
    );
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>🎟️ TicketHub</h1>
        <span style={{ color: '#999', fontSize: '0.85rem' }}>
          {user.email}{' '}
          <button
            onClick={signOut}
            style={{
              font: 'inherit',
              border: 'none',
              background: 'none',
              color: '#1565c0',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            sign out
          </button>
        </span>
      </header>

      {error && (
        <div style={{ margin: '1rem 0', padding: '0.75rem', background: '#ffebee', border: '1px solid #ef9a9a', borderRadius: 6, color: '#b71c1c' }}>
          {error}
        </div>
      )}

      {confirmation ? (
        <div style={{ marginTop: '1.5rem', padding: '1.5rem', background: '#e8f5e9', border: '2px solid #2e7d32', borderRadius: 8 }}>
          <h2 style={{ marginTop: 0 }}>✅ Booking confirmed</h2>
          <p>
            Seat <strong>{confirmation.seatLabel}</strong> for <strong>{confirmation.eventName}</strong> is yours.
          </p>
          <p style={{ color: '#666', fontSize: '0.85rem' }}>
            Booking <code>{confirmation.bookingId}</code> · a confirmation email was sent (check{' '}
            <code>docker compose logs notifications</code>).
          </p>
          <button onClick={backToEvents} style={{ padding: '0.5rem 1rem', font: 'inherit', cursor: 'pointer' }}>
            Book another seat
          </button>
        </div>
      ) : !event ? (
        <>
          <p style={{ color: '#555' }}>Pick an event:</p>
          {events === null && !error ? <p>Loading…</p> : <EventList events={events || []} onSelect={setEvent} />}
        </>
      ) : (
        <>
          <p>
            <button onClick={backToEvents} style={{ font: 'inherit', cursor: 'pointer', border: 'none', background: 'none', color: '#1565c0', padding: 0 }}>
              ← all events
            </button>
          </p>
          <h2 style={{ marginBottom: 4 }}>{event.name}</h2>
          <p style={{ color: '#666', marginTop: 0 }}>
            {event.venue}
            {event.startsAt && <> · {new Date(event.startsAt).toLocaleString()}</>}
          </p>
          {seats.length === 0 ? (
            <p style={{ color: '#777' }}>No seats seeded for this event yet.</p>
          ) : (
            <SeatGrid seats={seats} myHoldSeatId={hold?.seatId} onSeatClick={handleSeatClick} />
          )}
          {hold && (
            <CheckoutPanel hold={hold} onPay={handlePay} onRelease={() => releaseHold(hold)} busy={busy} />
          )}
        </>
      )}
    </main>
  );
}
