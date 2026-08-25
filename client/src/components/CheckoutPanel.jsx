import { useEffect, useState } from 'react';

// The sticky rail. It stays in view while the seat map scrolls, which is how
// every real checkout works - the thing you are about to pay for should never
// scroll off the screen.
export default function CheckoutPanel({ hold, onPay, onRelease, busy }) {
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(hold.expiresAt));
  const [simulateFailure, setSimulateFailure] = useState(false);

  useEffect(() => {
    setSecondsLeft(remaining(hold.expiresAt));
    const t = setInterval(() => setSecondsLeft(remaining(hold.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [hold.expiresAt]);

  const expired = secondsLeft <= 0;
  const total = hold.priceCents / 100;
  // Only turn urgent near the end; a countdown that is red the whole time
  // teaches people to ignore it.
  const urgent = !expired && secondsLeft <= 60;

  return (
    <div className="card overflow-hidden">
      <div className="accent-rule" />
      <div className="p-5">
        <h2 className="text-[15px] font-semibold tracking-tight">Your selection</h2>

        <div className="border-line mt-4 flex items-center justify-between border-b pb-4">
          <div>
            <div className="text-2xl font-semibold tracking-tight tabular-nums">{hold.label}</div>
            <div className="text-muted mt-0.5 text-xs">Seat</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tracking-tight tabular-nums">
              ${total.toFixed(2)}
            </div>
            <div className="text-muted mt-0.5 text-xs">Total</div>
          </div>
        </div>

        <div
          className={`mt-4 flex items-center justify-between rounded-lg px-3 py-2.5 text-sm ${
            expired
              ? 'text-danger'
              : urgent
                ? 'text-warn'
                : 'text-muted'
          }`}
          style={{
            background: expired
              ? 'color-mix(in srgb, var(--c-danger) 12%, transparent)'
              : urgent
                ? 'color-mix(in srgb, var(--c-warn) 14%, transparent)'
                : 'var(--c-canvas)',
          }}
        >
          <span>{expired ? 'Hold expired' : 'Reserved for you'}</span>
          <span className="font-mono text-base font-semibold tabular-nums">
            {expired ? '0:00' : format(secondsLeft)}
          </span>
        </div>

        {expired && (
          <p className="text-muted mt-2 text-xs leading-relaxed">
            This seat may have been taken by someone else. Pick another from the map.
          </p>
        )}

        <label className="text-faint mt-4 flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={simulateFailure}
            onChange={(e) => setSimulateFailure(e.target.checked)}
            className="accent-[var(--c-brand)]"
          />
          Simulate payment failure (demo)
        </label>

        <div className="mt-4 grid gap-2">
          <button
            onClick={() => onPay(simulateFailure)}
            disabled={busy || expired}
            className="btn btn-primary w-full !py-2.5"
          >
            {busy ? 'Processing…' : `Pay $${total.toFixed(2)}`}
          </button>
          <button onClick={onRelease} disabled={busy} className="btn btn-ghost w-full">
            Release seat
          </button>
        </div>

        <p className="text-faint mt-4 text-[11px] leading-relaxed">
          Your seat is held while you pay. If the hold expires the seat returns to the map.
        </p>
      </div>
    </div>
  );
}

function remaining(expiresAt) {
  return Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
}

function format(total) {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
