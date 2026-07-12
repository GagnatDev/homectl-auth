-- Refresh-token rotation reuse tolerance.
--
-- The forward-auth sidecar (packages/proxy) is stateless: its session lives
-- entirely in an encrypted cookie, so several concurrent browser requests can
-- each carry the SAME refresh token and all cross the refresh threshold at
-- once. Previously rotateSession hard-DELETEd the presented token, so the first
-- concurrent refresh won and every other in-flight request got a 401 — the
-- sidecar then cleared the session and bounced the user to login. This looked
-- like a session-TTL problem (it recurs roughly every access-token lifetime)
-- but is actually a rotation race.
--
-- Fix: instead of deleting a rotated token, stamp it with rotated_at and keep
-- the row for a short grace window. A token presented again within the window
-- is a legitimate concurrent refresh and is honoured (its caller gets a fresh
-- successor); presented after the window it is treated as replay and rejected.
-- The cleanup job purges rows once they are well past the grace window.
ALTER TABLE homectl_auth.sessions
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sessions_rotated_at_idx
  ON homectl_auth.sessions (rotated_at);
