// Thin fetch wrapper for the API gateway (Vite proxies /api → :8080).
export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Fake identity (auth is explicitly deferred — see DESIGN.md): a stable
// per-browser userId so holds/bookings behave like a logged-in user.
export function getUserId() {
  let id = localStorage.getItem('tickethub-user');
  if (!id) {
    id = 'user-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('tickethub-user', id);
  }
  return id;
}
