import { useCallback, useEffect, useState } from 'react';
import { api, getUser, clearSession } from './api.js';
import AppShell from './components/AppShell.jsx';
import AuthPanel from './components/AuthPanel.jsx';
import EventList from './components/EventList.jsx';
import SeatGrid from './components/SeatGrid.jsx';
import CheckoutPanel from './components/CheckoutPanel.jsx';
import MyBookings from './components/MyBookings.jsx';

export default function App() {
  const [user, setUser] = useState(getUser);
  const [view, setView] = useState('events'); // events | bookings
  const [events, setEvents] = useState(null);
  const [query, setQuery] = useState('');
  const [event, setEvent] = useState(null); // selected event
  const [seats, setSeats] = useState([]);
  const [hold, setHold] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadEvents = useCallback(async (q) => {
    const path = q ? `/catalog/events?q=${encodeURIComponent(q)}` : '/catalog/events';
    return api(path);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setEvents(null);
    // Debounced: typing a query shouldn't fire a request per keystroke.
    const t = setTimeout(() => {
      loadEvents(query)
        .then((list) => !cancelled && setEvents(list))
        .catch((e) => !cancelled && setError(`Could not load events: ${e.message}`));
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [user, query, loadEvents]);

  const refreshSeats = useCallback(async (eventId) => {
    const data = await api(`/booking/events/${eventId}/seats`);
    setSeats(data.seats);
    return data.seats;
  }, []);

  // Poll while looking at a seat map so other people's holds and bookings show up.
  useEffect(() => {
    if (!event || confirmation) return;
    refreshSeats(event._id).catch(() => {});
    const t = setInterval(() => refreshSeats(event._id).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [event, confirmation, refreshSeats]);

  const loadBookings = useCallback(async () => {
    setBookings(null);
    try {
      const data = await api('/booking/bookings');
      setBookings(data.bookings);
    } catch (e) {
      setError(e.message);
      setBookings([]);
    }
  }, []);

  useEffect(() => {
    if (view === 'bookings' && user) loadBookings();
  }, [view, user, loadBookings]);

  // Any 401 means api() already cleared the stored token, so the UI must stop
  // pretending we are signed in.
  useEffect(() => {
    if (error && /token|authentication/i.test(error)) setUser(null);
  }, [error]);

  async function handleSeatClick(seat) {
    setError(null);
    if (hold && hold.seatId === seat.id) return;
    try {
      setBusy(true);
      if (hold) await releaseHold(hold, true); // switching seats
      const h = await api('/booking/holds', {
        method: 'POST',
        body: JSON.stringify({ eventId: event._id, seatId: seat.id }),
      });
      setHold({
        seatId: seat.id,
        label: seat.label,
        priceCents: seat.priceCents,
        expiresAt: h.expiresAt,
      });
      await refreshSeats(event._id);
    } catch (e) {
      setError(
        e.status === 409 ? `Seat ${seat.label} was just taken — pick another.` : e.message
      );
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
      else if (e.status === 502)
        setError('Payment status unknown — it will be resolved automatically. Check My bookings.');
      else setError(e.message);
      setHold(null);
      refreshSeats(event._id).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function backToEvents() {
    if (hold) releaseHold(hold, true);
    setEvent(null);
    setConfirmation(null);
    setError(null);
  }

  function signOut() {
    clearSession();
    setUser(null);
    setEvent(null);
    setHold(null);
    setConfirmation(null);
    setBookings(null);
    setError(null);
  }

  function navigate(next) {
    if (hold) releaseHold(hold, true);
    setEvent(null);
    setConfirmation(null);
    setError(null);
    setView(next);
  }

  if (!user) {
    return (
      <AppShell user={null} view={view} onNavigate={() => {}} onSignOut={signOut}>
        <AuthPanel onAuthenticated={setUser} />
      </AppShell>
    );
  }

  return (
    <AppShell user={user} view={view} onNavigate={navigate} onSignOut={signOut}>
      {error && (
        <div
          className="text-danger mb-6 flex items-start justify-between gap-4 rounded-xl px-4 py-3 text-sm"
          style={{ background: 'color-mix(in srgb, var(--c-danger) 12%, transparent)' }}
          role="alert"
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="cursor-pointer opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {confirmation ? (
        <Confirmation confirmation={confirmation} onDone={backToEvents} />
      ) : view === 'bookings' ? (
        <>
          <PageHeader title="My bookings" subtitle="Every seat you've reserved." />
          <MyBookings
            bookings={bookings || []}
            loading={bookings === null}
            onRefresh={loadBookings}
          />
        </>
      ) : !event ? (
        <>
          <PageHeader
            title="Events"
            subtitle="Pick an event to choose your seats."
            actions={
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search events, venues…"
                className="input sm:w-72"
                type="search"
              />
            }
          />
          <EventList events={events || []} onSelect={setEvent} loading={events === null} />
        </>
      ) : (
        <>
          <button
            onClick={backToEvents}
            className="text-muted hover:text-ink mb-4 flex cursor-pointer items-center gap-1.5 text-sm"
          >
            ← All events
          </button>

          <PageHeader
            title={event.name}
            subtitle={[
              event.venue,
              event.startsAt && new Date(event.startsAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            ]
              .filter(Boolean)
              .join(' · ')}
          />

          {seats.length === 0 ? (
            <div className="card grid place-items-center px-6 py-20 text-center">
              <div className="max-w-md">
                <div className="mb-4 text-4xl">🪑</div>
                <h3 className="text-lg font-semibold">No seats seeded yet</h3>
                <p className="text-muted mt-2 text-sm">
                  Run{' '}
                  <code className="text-ink font-mono text-xs">
                    docker compose exec -T booking node scripts/seed.js {event._id} 5 10
                  </code>
                </p>
              </div>
            </div>
          ) : (
            // The split: seat map takes the width it needs, the rail stays put.
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
              <SeatGrid
                seats={seats}
                myHoldSeatId={hold?.seatId}
                onSeatClick={handleSeatClick}
                busy={busy}
              />
              <aside className="xl:sticky xl:top-20">
                {hold ? (
                  <CheckoutPanel
                    hold={hold}
                    onPay={handlePay}
                    onRelease={() => releaseHold(hold)}
                    busy={busy}
                  />
                ) : (
                  <div className="card border-dashed p-8 text-center">
                    <div className="mb-3 text-3xl opacity-60">🎟️</div>
                    <h3 className="text-sm font-semibold">Choose a seat</h3>
                    <p className="text-muted mt-1.5 text-xs leading-relaxed">
                      Select any available seat from the map. It's held for you while you pay.
                    </p>
                  </div>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="text-muted mt-1 text-sm">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

function Confirmation({ confirmation, onDone }) {
  return (
    <div className="grid place-items-center py-12">
      <div className="card w-full max-w-md overflow-hidden text-center">
        <div className="accent-rule" />
        <div className="p-8">
          <div
            className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl text-2xl"
            style={{
              background: 'color-mix(in srgb, var(--c-success) 16%, transparent)',
              color: 'var(--c-success)',
            }}
          >
            ✓
          </div>
          <h2 className="text-lg font-semibold tracking-tight">Booking confirmed</h2>
          <p className="text-muted mt-2 text-sm">
            Seat <strong className="text-ink">{confirmation.seatLabel}</strong> for{' '}
            <strong className="text-ink">{confirmation.eventName}</strong> is yours.
          </p>

          <div className="bg-canvas border-line mt-5 rounded-lg border px-3 py-2.5 text-left">
            <div className="text-faint text-[10px] font-medium tracking-wide uppercase">
              Booking reference
            </div>
            <div className="mt-1 font-mono text-xs break-all">{confirmation.bookingId}</div>
          </div>

          <p className="text-faint mt-4 text-xs">
            A confirmation email was sent — check{' '}
            <code className="font-mono">docker compose logs notifications</code>.
          </p>

          <button onClick={onDone} className="btn btn-primary mt-6 w-full !py-2.5">
            Book another seat
          </button>
        </div>
      </div>
    </div>
  );
}
