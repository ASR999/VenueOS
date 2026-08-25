const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const migrate = require('./migrate');
const createMetrics = require('./metrics');
const { hashPassword, verifyPassword } = require('./password');

const PORT = process.env.PORT || 4005;
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
const MIN_PASSWORD_LENGTH = parseInt(process.env.MIN_PASSWORD_LENGTH || '8', 10);

// Refuse to start rather than issue tokens anyone can forge. A default secret is
// worse than no auth at all: it looks protected and isn't.
if (!JWT_SECRET) {
  console.error('auth: JWT_SECRET is required');
  process.exit(1);
}

const metrics = createMetrics('auth');
const authAttempts = new metrics.client.Counter({
  name: 'tickethub_auth_attempts_total',
  help: 'Authentication attempts by action and outcome',
  labelNames: ['action', 'outcome'], // signup|login x success|failure
  registers: [metrics.register],
});

const app = express();
app.use(metrics.middleware);
app.get('/metrics', metrics.handler);
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let server = null;
let shuttingDown = false;

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'auth', status: 'ok', postgres: 'ok' });
  } catch {
    res.status(503).json({ service: 'auth', status: 'degraded', postgres: 'down' });
  }
});

function issueToken(user) {
  // `sub` is the user id, and it is what every downstream service treats as the
  // caller's identity. Nothing else in the system may set it.
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
    issuer: 'tickethub-auth',
  });
}

function validateCredentials(body) {
  const { email, password } = body || {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return 'a valid email is required';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

app.post(
  '/signup',
  ah(async (req, res) => {
    const invalid = validateCredentials(req.body);
    if (invalid) {
      authAttempts.inc({ action: 'signup', outcome: 'failure' });
      return res.status(400).json({ error: invalid });
    }
    const email = req.body.email.trim();

    const passwordHash = await hashPassword(req.body.password);
    let user;
    try {
      const r = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
        [email, passwordHash]
      );
      user = r.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        authAttempts.inc({ action: 'signup', outcome: 'failure' });
        return res.status(409).json({ error: 'that email is already registered' });
      }
      throw err;
    }

    authAttempts.inc({ action: 'signup', outcome: 'success' });
    res.status(201).json({ token: issueToken(user), user: { id: user.id, email: user.email } });
  })
);

app.post(
  '/login',
  ah(async (req, res) => {
    const invalid = validateCredentials(req.body);
    if (invalid) {
      authAttempts.inc({ action: 'login', outcome: 'failure' });
      return res.status(400).json({ error: invalid });
    }

    const r = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)',
      [req.body.email.trim()]
    );
    const user = r.rows[0];

    // Deliberately identical response for "no such user" and "wrong password".
    // Distinguishing them turns the login form into an account-enumeration
    // oracle: an attacker learns which emails are registered.
    const ok = user && (await verifyPassword(req.body.password, user.password_hash));
    if (!ok) {
      authAttempts.inc({ action: 'login', outcome: 'failure' });
      return res.status(401).json({ error: 'invalid email or password' });
    }

    authAttempts.inc({ action: 'login', outcome: 'success' });
    res.json({ token: issueToken(user), user: { id: user.id, email: user.email } });
  })
);

// Lets a client check whether a stored token is still good without guessing.
app.get(
  '/me',
  ah(async (req, res) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'authentication required' });
    try {
      const claims = jwt.verify(token, JWT_SECRET, { issuer: 'tickethub-auth' });
      res.json({ id: claims.sub, email: claims.email });
    } catch {
      res.status(401).json({ error: 'invalid or expired token' });
    }
  })
);

app.use((err, req, res, next) => {
  console.error('auth: unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

// Stop accepting requests, let in-flight ones finish, then release resources.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`auth: ${signal} received — draining`);

  setTimeout(() => {
    console.error('auth: drain timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    await closed;
  }
  await Promise.allSettled([pool.end()]);
  console.log('auth: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate(pool);
  server = app.listen(PORT, () => console.log(`auth service listening on :${PORT}`));
}

start().catch((err) => {
  console.error('auth failed to start:', err);
  process.exit(1);
});
