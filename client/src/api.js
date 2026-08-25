// Thin fetch wrapper for the API gateway (Vite proxies /api → :8080).
const TOKEN_KEY = 'tickethub-token';
const USER_KEY = 'tickethub-user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // An expired or rejected token means the stored session is worthless.
    // Keeping it would leave the UI insisting you are logged in while every
    // action fails.
    if (res.status === 401) clearSession();
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// The user id is never sent by the client any more - the server reads it from
// the token. These just establish the session.
export async function signup(email, password) {
  const body = await api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setSession(body.token, body.user);
  return body.user;
}

export async function login(email, password) {
  const body = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setSession(body.token, body.user);
  return body.user;
}
