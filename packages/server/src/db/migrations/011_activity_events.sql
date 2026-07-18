-- Per-user, per-app activity log powering the admin statistics pages.
--
-- One row per meaningful auth event:
--   'login'      — successful credential POST /login
--   'sso_login'  — GET /authorize short-circuited by a valid SSO cookie
--   'refresh'    — refresh-token rotation (browser or internal); coalesced in
--                  code to at most one row per user+app+hour so an active
--                  session doesn't write a row every access-token lifetime
--
-- Rows are pruned by the cleanup job after ACTIVITY_RETENTION_DAYS (default
-- 90), so the table stays bounded regardless of traffic.
CREATE TABLE homectl_auth.activity_events (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES homectl_auth.users(id) ON DELETE CASCADE,
  client_id   TEXT        NOT NULL,
  event_type  TEXT        NOT NULL CHECK (event_type IN ('login', 'sso_login', 'refresh')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Time-scoped aggregates (dashboards) scan by occurred_at; per-user and
-- per-app views scan by (user_id|client_id, occurred_at).
CREATE INDEX activity_events_occurred_at_idx
  ON homectl_auth.activity_events (occurred_at);
CREATE INDEX activity_events_user_occurred_idx
  ON homectl_auth.activity_events (user_id, occurred_at DESC);
CREATE INDEX activity_events_client_occurred_idx
  ON homectl_auth.activity_events (client_id, occurred_at DESC);
