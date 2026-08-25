import { useState } from 'react';
import { login, signup } from '../api.js';

export default function AuthPanel({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = mode === 'login' ? await login(email, password) : await signup(email, password);
      onAuthenticated(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '3rem auto' }}>
      <h2 style={{ marginTop: 0 }}>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        You need an account to hold or book a seat. Browsing is open to everyone.
      </p>

      {error && (
        <div
          style={{
            margin: '1rem 0',
            padding: '0.75rem',
            background: '#ffebee',
            border: '1px solid #ef9a9a',
            borderRadius: 6,
            color: '#b71c1c',
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', color: '#555' }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', color: '#555' }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            style={inputStyle}
          />
          {mode === 'signup' && (
            <span style={{ fontSize: '0.75rem', color: '#888' }}>At least 8 characters.</span>
          )}
        </label>
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '0.6rem 1rem',
            background: '#2e7d32',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: busy ? 'not-allowed' : 'pointer',
            font: 'inherit',
          }}
        >
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Sign up'}
        </button>
      </form>

      <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
        {mode === 'login' ? "Don't have an account? " : 'Already registered? '}
        <button
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login');
            setError(null);
          }}
          style={{
            font: 'inherit',
            border: 'none',
            background: 'none',
            color: '#1565c0',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {mode === 'login' ? 'Sign up' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}

const inputStyle = {
  padding: '0.5rem',
  font: 'inherit',
  border: '1px solid #ccc',
  borderRadius: 6,
};
