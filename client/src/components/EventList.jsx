export default function EventList({ events, onSelect }) {
  if (events.length === 0) {
    return (
      <p style={{ color: '#777' }}>
        No events yet. Create one:{' '}
        <code>POST /api/catalog/events</code> then seed seats — see CLAUDE.md.
      </p>
    );
  }
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {events.map((ev) => (
        <button
          key={ev._id}
          onClick={() => onSelect(ev)}
          style={{
            textAlign: 'left',
            padding: '1rem',
            border: '1px solid #ddd',
            borderRadius: 8,
            background: 'white',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          <strong>{ev.name}</strong>
          <div style={{ color: '#666', fontSize: '0.9rem', marginTop: 4 }}>
            {ev.venue || 'Venue TBA'}
            {ev.startsAt && <> · {new Date(ev.startsAt).toLocaleString()}</>}
          </div>
          {ev.description && (
            <div style={{ color: '#888', fontSize: '0.85rem', marginTop: 4 }}>{ev.description}</div>
          )}
        </button>
      ))}
    </div>
  );
}
