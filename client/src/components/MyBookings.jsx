// Uses GET /api/booking/bookings, which only exists because auth does. It is
// also where a "payment status unknown" booking finally becomes visible: it
// shows as pending until the reconciling sweep settles it.
export default function MyBookings({ bookings, loading, onRefresh }) {
  if (loading) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
    );
  }

  if (bookings.length === 0) {
    return (
      <div className="card grid place-items-center px-6 py-20 text-center">
        <div className="max-w-md">
          <div className="mb-4 text-4xl">🎫</div>
          <h3 className="text-lg font-semibold">No bookings yet</h3>
          <p className="text-muted mt-2 text-sm">
            Pick an event and choose a seat — your tickets will appear here.
          </p>
        </div>
      </div>
    );
  }

  const pending = bookings.filter((b) => b.status === 'pending').length;

  return (
    <div className="grid gap-3">
      {pending > 0 && (
        <div
          className="text-muted rounded-xl px-4 py-3 text-sm"
          style={{ background: 'color-mix(in srgb, var(--c-warn) 12%, transparent)' }}
        >
          <strong className="text-warn font-medium">
            {pending} booking{pending > 1 ? 's are' : ' is'} still settling.
          </strong>{' '}
          The payment outcome is being reconciled automatically — this resolves on its own.{' '}
          <button onClick={onRefresh} className="text-brand cursor-pointer font-medium hover:underline">
            Refresh
          </button>
        </div>
      )}

      {bookings.map((b) => (
        <article key={b.id} className="card flex flex-wrap items-center gap-4 p-4 sm:gap-6">
          <div
            className="grid size-12 shrink-0 place-items-center rounded-xl text-base font-semibold tabular-nums"
            style={{
              background:
                b.status === 'confirmed'
                  ? 'var(--grad-brand)'
                  : 'color-mix(in srgb, var(--c-ink) 8%, transparent)',
              color: b.status === 'confirmed' ? 'var(--c-brand-ink)' : 'var(--c-muted)',
            }}
          >
            {b.seat_label}
          </div>

          <div className="min-w-[180px] flex-1">
            <div className="text-[15px] font-medium">Seat {b.seat_label}</div>
            <div className="text-faint mt-0.5 font-mono text-xs break-all">{b.id}</div>
          </div>

          <div className="text-muted text-sm tabular-nums">
            ${(b.price_cents / 100).toFixed(2)}
          </div>

          <div className="text-faint hidden text-sm tabular-nums lg:block">
            {new Date(b.created_at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </div>

          <StatusBadge status={b.status} />
        </article>
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    confirmed: { color: 'var(--c-success)', label: 'Confirmed', icon: '✓' },
    pending: { color: 'var(--c-warn)', label: 'Settling', icon: '◷' },
    cancelled: { color: 'var(--c-faint)', label: 'Cancelled', icon: '✕' },
  };
  const s = map[status] || map.cancelled;
  return (
    <span
      className="badge"
      style={{
        color: s.color,
        background: `color-mix(in srgb, ${s.color} 14%, transparent)`,
      }}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}
