// The seat map owns the width in the split-pane layout. Rows are laid out with
// an aisle down the middle so the shape reads as a room rather than a table.
export default function SeatGrid({ seats, myHoldSeatId, onSeatClick, busy }) {
  const rows = new Map();
  for (const seat of seats) {
    const row = seat.label.split('-')[0];
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(seat);
  }
  for (const list of rows.values()) {
    list.sort((a, b) => Number(a.label.split('-')[1]) - Number(b.label.split('-')[1]));
  }

  const counts = seats.reduce(
    (acc, s) => ({ ...acc, [s.status]: (acc[s.status] || 0) + 1 }),
    {}
  );

  return (
    <section className="card overflow-hidden">
      <div className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <Legend className="seat-available" label="Available" count={counts.available || 0} />
          <Legend className="seat-held" label="Held" count={counts.held || 0} />
          <Legend className="seat-booked" label="Booked" count={counts.booked || 0} />
          <Legend className="seat-mine" label="Your hold" />
        </div>
        <span className="text-faint text-xs tabular-nums">{seats.length} seats</span>
      </div>

      <div className="overflow-x-auto px-5 py-8">
        <div className="mx-auto w-fit min-w-full">
          <div className="mb-8 flex flex-col items-center gap-2">
            <div
              className="h-1.5 w-full max-w-2xl rounded-full"
              style={{ background: 'var(--grad-brand)' }}
            />
            <span className="text-faint text-[10px] font-medium tracking-[0.3em] uppercase">
              Stage
            </span>
          </div>

          <div className="flex flex-col items-center gap-2">
            {[...rows.entries()].map(([row, rowSeats]) => {
              const half = Math.ceil(rowSeats.length / 2);
              return (
                <div key={row} className="flex items-center gap-3">
                  <span className="text-faint w-4 text-right text-[11px] font-medium tabular-nums">
                    {row}
                  </span>
                  <div className="flex gap-1.5">
                    {rowSeats.slice(0, half).map((seat) => (
                      <Seat
                        key={seat.id}
                        seat={seat}
                        mine={seat.id === myHoldSeatId}
                        busy={busy}
                        onClick={onSeatClick}
                      />
                    ))}
                  </div>
                  <div className="w-6" aria-hidden />
                  <div className="flex gap-1.5">
                    {rowSeats.slice(half).map((seat) => (
                      <Seat
                        key={seat.id}
                        seat={seat}
                        mine={seat.id === myHoldSeatId}
                        busy={busy}
                        onClick={onSeatClick}
                      />
                    ))}
                  </div>
                  <span className="text-faint w-4 text-[11px] font-medium tabular-nums">{row}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function Seat({ seat, mine, busy, onClick }) {
  const clickable = !busy && (mine || seat.status === 'available');
  const cls = mine ? 'seat-mine' : `seat-${seat.status}`;
  const price = `$${(seat.priceCents / 100).toFixed(2)}`;

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => clickable && onClick(seat)}
      title={`${seat.label} · ${price} · ${mine ? 'your hold' : seat.status}`}
      aria-label={`Seat ${seat.label}, ${price}, ${mine ? 'your hold' : seat.status}`}
      className={`seat ${cls}`}
    >
      {seat.label.split('-')[1]}
    </button>
  );
}

function Legend({ className, label, count }) {
  return (
    <span className="text-muted flex items-center gap-1.5 text-xs">
      <span className={`${className} !size-3.5 !rounded-[4px]`} style={{ boxShadow: 'none' }} />
      {label}
      {count !== undefined && <span className="text-faint tabular-nums">({count})</span>}
    </span>
  );
}
