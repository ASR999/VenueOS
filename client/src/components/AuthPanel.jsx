import { useState } from 'react';
import { login, signup } from '../api.js';

// The one screen where a narrow column is right: a two-field form stretched
// across 1600px would be worse, not better. It is centred in the full viewport
// rather than sitting in a boxed page.
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
    <div className="grid min-h-[calc(100dvh-8rem)] place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div
            className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl text-xl"
            style={{ background: 'var(--grad-brand)' }}
          >
            🎟️
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {mode === 'login' ? 'Sign in to VenueOS' : 'Create your account'}
          </h1>
          <p className="text-muted mt-1.5 text-sm">
            You need an account to hold or book a seat.
          </p>
        </div>

        <div className="card overflow-hidden">
          <div className="accent-rule" />
          <form onSubmit={handleSubmit} className="grid gap-4 p-6">
            {error && (
              <div
                className="text-danger rounded-lg px-3 py-2.5 text-sm"
                style={{ background: 'color-mix(in srgb, var(--c-danger) 12%, transparent)' }}
                role="alert"
              >
                {error}
              </div>
            )}

            <label className="grid gap-1.5">
              <span className="text-muted text-xs font-medium">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="input"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-muted text-xs font-medium">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                className="input"
              />
              {mode === 'signup' && (
                <span className="text-faint text-[11px]">At least 8 characters.</span>
              )}
            </label>

            <button type="submit" disabled={busy} className="btn btn-primary w-full !py-2.5">
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-muted mt-5 text-center text-sm">
          {mode === 'login' ? "Don't have an account? " : 'Already registered? '}
          <button
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError(null);
            }}
            className="text-brand cursor-pointer font-medium hover:underline"
          >
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
