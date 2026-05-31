-- The admin is no longer a local user row (it maps from a GitHub identity), so
-- invite_tokens.created_by_user_id can no longer be a UUID FK into users.
-- Widen it to a nullable opaque audit string: "github:<id>" for the GitHub
-- admin, or a user UUID (as text) for delegated app-user invites.
ALTER TABLE homectl_auth.invite_tokens
  DROP CONSTRAINT IF EXISTS invite_tokens_created_by_user_id_fkey;

ALTER TABLE homectl_auth.invite_tokens
  ALTER COLUMN created_by_user_id DROP NOT NULL,
  ALTER COLUMN created_by_user_id TYPE TEXT USING created_by_user_id::text;
