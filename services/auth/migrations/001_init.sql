-- Users. Passwords are never stored: only a scrypt hash and the per-user salt
-- it was derived with (see src/password.js for why scrypt and not a plain digest).
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Ayush@example.com" and "ayush@example.com" are
-- the same person, and letting both sign up creates two accounts one human
-- cannot tell apart.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
