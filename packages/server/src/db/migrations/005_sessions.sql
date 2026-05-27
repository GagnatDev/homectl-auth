-- Refresh token sessions — one row per active browser session, per app.
CREATE TABLE homectl_auth.sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT        NOT NULL UNIQUE,
  user_id      UUID        NOT NULL REFERENCES homectl_auth.users(id) ON DELETE CASCADE,
  client_id    TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_token_hash_idx  ON homectl_auth.sessions (token_hash);
CREATE INDEX sessions_user_id_idx     ON homectl_auth.sessions (user_id);
CREATE INDEX sessions_expires_at_idx  ON homectl_auth.sessions (expires_at);
