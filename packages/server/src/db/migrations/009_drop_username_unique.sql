-- Email is the unique identity for a user; username is a display handle only and
-- may legitimately collide (e.g. when migrating users in from apps that never
-- enforced global username uniqueness). Drop the UNIQUE constraint on username.
-- `users_username_key` is the constraint Postgres auto-generated for the inline
-- UNIQUE in migration 002.
--
-- DROP CONSTRAINT requires *table ownership*, and the app's DATABASE_URL role
-- may not own the table (in prod it does not — the 2026-07-10 deploy
-- crashlooped on `must be owner of table users`). Migrations run in-process at
-- startup, so a hard failure here takes the whole service down. Instead: try
-- the drop, and if the role lacks ownership, skip it with a WARNING so the
-- service still boots. The constraint then stays in place until a role that
-- owns the table runs the ALTER manually:
--
--   ALTER TABLE homectl_auth.users DROP CONSTRAINT IF EXISTS users_username_key;
--
-- While the constraint remains, the user-import endpoint reports a duplicate
-- username as a per-entry `invalid` result instead of creating the user.
DO $$
BEGIN
  ALTER TABLE homectl_auth.users
    DROP CONSTRAINT IF EXISTS users_username_key;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'users_username_key not dropped (%). Run as the table owner: ALTER TABLE homectl_auth.users DROP CONSTRAINT IF EXISTS users_username_key;', SQLERRM;
END;
$$;
