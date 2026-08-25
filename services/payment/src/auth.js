// JWT verification. Duplicated per service rather than shared, like metrics.js
// and migrate.js - each service is its own npm package.
//
// Every service verifies the signature itself instead of trusting a header the
// gateway sets. That matters here concretely: every service port is published on
// the host, so a gateway-injected `X-User-Id` could be forged with one curl.
// A signature cannot.
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('JWT_SECRET is required');
  process.exit(1);
}

// The caller's identity comes from the token and nowhere else. Any userId in a
// request body is ignored - that string was the whole vulnerability before auth
// existed, because the service had no way to know the caller really was them.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'authentication required' });
  }
  try {
    const claims = jwt.verify(header.slice(7), JWT_SECRET, { issuer: 'tickethub-auth' });
    req.userId = claims.sub;
    req.userEmail = claims.email;
    next();
  } catch (err) {
    // Expired is worth distinguishing: the client can refresh rather than
    // making the user think their password stopped working.
    const expired = err.name === 'TokenExpiredError';
    res.status(401).json({ error: expired ? 'token expired' : 'invalid token' });
  }
}

// For calls between services, where there is no end user to authenticate.
// Booking mints one of these to reach payment through the gateway.
//
// TRADE-OFF, deliberate: HS256 with one shared secret means every service can
// mint a token every other service will trust - including a user token. RS256,
// where only auth holds the private key and services verify with the public
// one, removes that. Recorded in DESIGN.md rather than pretended away.
function serviceToken(name) {
  return jwt.sign({ sub: `service:${name}`, svc: name }, JWT_SECRET, {
    expiresIn: '5m',
    issuer: 'tickethub-auth',
  });
}

function requireService(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'authentication required' });
  }
  try {
    const claims = jwt.verify(header.slice(7), JWT_SECRET, { issuer: 'tickethub-auth' });
    if (!claims.svc) return res.status(403).json({ error: 'service credentials required' });
    req.serviceName = claims.svc;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { requireAuth, requireService, serviceToken };
