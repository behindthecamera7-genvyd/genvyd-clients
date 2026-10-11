-- Tags Genvyd puts on ads (e.g. "instagram", "15s", "hero"). Lowercase, per file.
CREATE TABLE IF NOT EXISTS item_tags (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path, tag)
);
CREATE INDEX IF NOT EXISTS item_tags_client ON item_tags(client_slug, tag);
