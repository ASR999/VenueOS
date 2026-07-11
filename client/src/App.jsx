import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>TicketHub</h1>
      <p>Microservices scaffold — live service status via the API gateway:</p>
      {error && <p style={{ color: 'crimson' }}>Gateway unreachable: {error}</p>}
      {!health && !error && <p>Checking…</p>}
      {health && (
        <ul style={{ lineHeight: 2 }}>
          {Object.entries(health.services).map(([name, s]) => (
            <li key={name}>
              {name}: <strong>{s.status}</strong>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
