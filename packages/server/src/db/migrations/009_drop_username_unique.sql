-- Email is the unique identity for a user; username is a display handle only and
-- may legitimately collide (e.g. when migrating users in from apps that never
-- enforced global username uniqueness). Drop the UNIQUE constraint on username.
-- `username_key` is the constraint Postgres auto-generated for the inline UNIQUE
-- in migration 002; drop it defensively in case it was named differently.
ALTER TABLE homectl_auth.users
  DROP CONSTRAINT IF EXISTS users_username_key;
