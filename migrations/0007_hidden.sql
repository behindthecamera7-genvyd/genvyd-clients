-- Ads a client (or Genvyd) hid because they don't want them. Shared by everyone on that
-- client, reversible (Unhide). Genvyd can then delete hidden ads, which moves the file
-- into "_Deleted files" on the Synology.
CREATE TABLE IF NOT EXISTS hidden (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  hidden_by   TEXT NOT NULL,
  hidden_at   INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path)
);
