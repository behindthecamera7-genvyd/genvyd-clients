-- Every file the portal has seen on the Synology, so it knows what is new.
-- notified = 1 once the client has been emailed about it (or it predates alerts).
CREATE TABLE IF NOT EXISTS files (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_slug, path)
);
CREATE INDEX IF NOT EXISTS files_pending ON files(notified, client_slug);

-- Who has opened which file (drives "New to you" / "Viewed").
CREATE TABLE IF NOT EXISTS views (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  email       TEXT NOT NULL,
  viewed_at   INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path, email)
);
CREATE INDEX IF NOT EXISTS views_user ON views(client_slug, email);

-- Clients can switch "new work" emails off for themselves.
ALTER TABLE members ADD COLUMN email_alerts INTEGER NOT NULL DEFAULT 1;
