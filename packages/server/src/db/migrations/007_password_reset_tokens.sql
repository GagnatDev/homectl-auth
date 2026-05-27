-- Password reset tokens: admin-generated, single-use, 24h TTL.
CREATE TABLE homectl_auth.password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT        NOT NULL UNIQUE,
  user_id    UUID        NOT NULL REFERENCES homectl_auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX password_reset_tokens_token_hash_idx ON homectl_auth.password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_expires_at_idx ON homectl_auth.password_reset_tokens (expires_at);
