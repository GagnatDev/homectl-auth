-- Invite tokens: used by admins and privileged app users to onboard new users.
CREATE TABLE homectl_auth.invite_tokens (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          TEXT        NOT NULL UNIQUE,
  email               TEXT        NOT NULL,
  -- app_grants: JSON array of { appId, role } objects
  app_grants          JSONB       NOT NULL DEFAULT '[]',
  expires_at          TIMESTAMPTZ NOT NULL,
  created_by_user_id  UUID        NOT NULL REFERENCES homectl_auth.users(id) ON DELETE CASCADE,
  -- Non-null when created for an email that already has an account.
  -- Used to detect races where a different user claims the email.
  expected_user_id    UUID        REFERENCES homectl_auth.users(id) ON DELETE SET NULL,
  -- Non-null when created by a privileged app user (not admin)
  created_by_app_id   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX invite_tokens_token_hash_idx ON homectl_auth.invite_tokens (token_hash);
CREATE INDEX invite_tokens_email_idx      ON homectl_auth.invite_tokens (email);
CREATE INDEX invite_tokens_expires_at_idx ON homectl_auth.invite_tokens (expires_at);
