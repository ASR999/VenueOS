import { useEffect, useState } from 'react';

export default function CheckoutPanel({ hold, onPay, onRelease, busy }) {
  const [secondsLeft, setSecondsLeft] = useState(remaining(hold.expiresAt));
  const [simulateFailure, setSimulateFailure] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setSecondsLeft(remaining(hold.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [hold.expiresAt]);

  const expired = secondsLeft <= 0;

  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '1rem',
        border: '2px solid #2e7d32',
        borderRadius: 8,
        background: '#f1f8e9',
      }}
    >
      <strong>
        Seat {hold.label} held — ${(hold.priceCents / 100).toFixed(2)}
      </strong>
      <div style={{ margin: '0.5rem 0', color: expired ? 'crimson' : '#555' }}>
        {expired
          ? 'Hold expired — the seat may be taken by someone else now.'
          : `Reserved for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} while you pay.`}
      </div>
      <label style={{ display: 'block', margin: '0.5rem 0', fontSize: '0.85rem', color: '#777' }}>
        <input
          type="checkbox"
          checked={simulateFailure}
          onChange={(e) => setSimulateFailure(e.target.checked)}
        />{' '}
        Simulate payment failure (demo)
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={() => onPay(simulateFailure)}
          disabled={busy || expired}
          style={{
            padding: '0.5rem 1.25rem',
            background: '#2e7d32',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: busy || expired ? 'not-allowed' : 'pointer',
            font: 'inherit',
          }}
        >
          {busy ? 'Processing…' : 'Pay now'}
        </button>
        <button
          onClick={onRelease}
          disabled={busy}
          style={{
            padding: '0.5rem 1rem',
            background: 'white',
            border: '1px solid #ccc',
            borderRadius: 6,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Release seat
        </button>
      </div>
    </div>
  );
}

function remaining(expiresAt) {
  return Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
}
