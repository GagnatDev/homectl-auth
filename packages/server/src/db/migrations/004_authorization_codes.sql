-- Short-lived single-use codes for the authorization code flow.
CREATE TABLE homectl_auth.authorization_codes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash    TEXT        NOT NULL UNIQUE,
  client_id    TEXT        NOT NULL,
  user_id      UUID        NOT NULL REFERENCES homectl_auth.users(id) ON DELETE CASCADE,
  redirect_uri TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_codes_code_hash_idx ON homectl_auth.authorization_codes (code_hash);
CREATE INDEX auth_codes_expires_at_idx ON homectl_auth.authorization_codes (expires_at);
