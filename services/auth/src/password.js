// Password hashing with Node's built-in scrypt. No dependency, and scrypt is a
// real password KDF: deliberately slow and memory-hard, so a stolen database
// cannot be brute-forced at GPU speed. A plain SHA-256 would be catastrophic
// here precisely because it is fast.
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// Node's defaults (N=16384, r=8, p=1) are the published baseline. Raising N
// costs verification latency on every login, so it is a knob, not a free win.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Stored as scrypt$N$r$p$salt$hash so the parameters travel with the hash.
// Without them, raising N later would silently invalidate every existing
// password - the record has to say how it was made.
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });

  // timingSafeEqual, not ===: a normal comparison returns as soon as two bytes
  // differ, and that timing difference leaks the hash one byte at a time.
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
