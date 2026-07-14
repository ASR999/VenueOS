const SEAT_STYLE = {
  available: { background: '#e8f5e9', border: '1px solid #a5d6a7', cursor: 'pointer' },
  held: { background: '#eee', border: '1px solid #ccc', color: '#999', cursor: 'not-allowed' },
  booked: { background: '#333', border: '1px solid #333', color: '#fff', cursor: 'not-allowed' },
  mine: { background: '#c8e6c9', border: '2px solid #2e7d32', cursor: 'pointer', fontWeight: 700 },
};

export default function SeatGrid({ seats, myHoldSeatId, onSeatClick }) {
  // Group "A-1".."A-10" into row A, etc.
  const rows = {};
  for (const seat of seats) {
    const row = seat.label.split('-')[0];
    (rows[row] = rows[row] || []).push(seat);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
        <Legend style={SEAT_STYLE.available} label="available" />
        <Legend style={SEAT_STYLE.held} label="held" />
        <Legend style={SEAT_STYLE.booked} label="booked" />
        <Legend style={SEAT_STYLE.mine} label="your hold" />
      </div>
      <div style={{ textAlign: 'center', color: '#999', letterSpacing: 4, marginBottom: 8 }}>
        STAGE
      </div>
      {Object.entries(rows).map(([row, rowSeats]) => (
        <div key={row} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <span style={{ width: 16, color: '#999', fontSize: '0.8rem' }}>{row}</span>
          {rowSeats.map((seat) => {
            const mine = seat.id === myHoldSeatId;
            const style = mine ? SEAT_STYLE.mine : SEAT_STYLE[seat.status];
            const clickable = mine || seat.status === 'available';
            return (
              <button
                key={seat.id}
                title={`${seat.label} — $${(seat.priceCents / 100).toFixed(2)} (${mine ? 'your hold' : seat.status})`}
                onClick={() => clickable && onSeatClick(seat)}
                disabled={!clickable}
                style={{
                  width: 44,
                  height: 36,
                  borderRadius: 6,
                  font: 'inherit',
                  fontSize: '0.75rem',
                  ...style,
                }}
              >
                {seat.label.split('-')[1]}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Legend({ style, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 14, height: 14, borderRadius: 3, display: 'inline-block', ...style }} />
      {label}
    </span>
  );
}
