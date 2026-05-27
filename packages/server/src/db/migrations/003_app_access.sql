-- Per-app role grants: which users have access to which apps and at what role.
CREATE TABLE homectl_auth.app_access (
  user_id    UUID NOT NULL REFERENCES homectl_auth.users(id) ON DELETE CASCADE,
  app_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id)
);

CREATE INDEX app_access_user_id_idx ON homectl_auth.app_access (user_id);
CREATE INDEX app_access_app_id_idx  ON homectl_auth.app_access (app_id);
