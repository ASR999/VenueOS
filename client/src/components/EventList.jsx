// A responsive grid, not a column: columns are added as the viewport widens
// rather than leaving the space empty. Four across on a laptop, six on a wide
// monitor, one on a phone.
export default function EventList({ events, onSelect, loading }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="card h-[168px] animate-pulse overflow-hidden">
            <div className="bg-line h-1 w-full" />
            <div className="space-y-3 p-5">
              <div className="bg-line h-4 w-3/4 rounded" />
              <div className="bg-line h-3 w-1/2 rounded" />
              <div className="bg-line h-3 w-2/3 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="card grid place-items-center px-6 py-20 text-center">
        <div className="max-w-md">
          <div className="mb-4 text-4xl">🎭</div>
          <h3 className="text-lg font-semibold">No events on sale</h3>
          <p className="text-muted mt-2 text-sm">
            Create one with <code className="text-ink font-mono text-xs">POST /api/catalog/events</code>,
            then seed its seats. See CLAUDE.md for the two commands.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {events.map((ev) => (
        <EventCard key={ev._id} event={ev} onSelect={onSelect} />
      ))}
    </div>
  );
}

function EventCard({ event, onSelect }) {
  const when = event.startsAt ? new Date(event.startsAt) : null;

  return (
    <button
      onClick={() => onSelect(event)}
      className="card card-lift flex cursor-pointer flex-col overflow-hidden text-left"
    >
      <div className="accent-rule" />
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[15px] leading-snug font-semibold tracking-tight">{event.name}</h3>
          {when && (
            <div className="border-line bg-canvas shrink-0 rounded-lg border px-2 py-1 text-center">
              <div className="text-faint text-[10px] font-medium tracking-wide uppercase">
                {when.toLocaleString(undefined, { month: 'short' })}
              </div>
              <div className="text-sm leading-none font-semibold tabular-nums">
                {when.getDate()}
              </div>
            </div>
          )}
        </div>

        <div className="text-muted space-y-1 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="text-faint">📍</span>
            <span className="truncate">{event.venue || 'Venue TBA'}</span>
          </div>
          {when && (
            <div className="flex items-center gap-1.5">
              <span className="text-faint">🕗</span>
              <span className="tabular-nums">
                {when.toLocaleString(undefined, {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </div>
          )}
        </div>

        {event.description && (
          <p className="text-faint line-clamp-2 text-xs leading-relaxed">{event.description}</p>
        )}

        <div className="border-line mt-auto flex items-center justify-between border-t pt-3">
          <span className="text-faint text-xs">Select seats</span>
          <span className="text-brand text-sm font-medium">→</span>
        </div>
      </div>
    </button>
  );
}
