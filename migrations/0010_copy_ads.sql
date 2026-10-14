-- Ad copy belongs to an ad. ad_path is the folder path of the ad it goes with (any size or
-- version of it, or the name without an extension when it came from a copy file); the portal
-- matches it to the ad the same way it folds sizes and versions together.
-- source is the copy file it was read from ("<folder>/<ad name>.copy.txt"), or NULL when
-- Genvyd typed it in the portal.
ALTER TABLE copy_items ADD COLUMN ad_path TEXT;
ALTER TABLE copy_items ADD COLUMN source TEXT;
CREATE INDEX IF NOT EXISTS copy_items_ad ON copy_items(client_slug, ad_path);
-- Copy files already read, so each one is only imported again when it changes.
CREATE TABLE IF NOT EXISTS copy_imports (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  sig         TEXT NOT NULL,      -- size|mtime of the file when it was read
  lines       INTEGER,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path)
);
