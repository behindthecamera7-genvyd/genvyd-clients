-- Stable file IDs. Every file the portal knows gets a permanent number that survives renames
-- made in the portal. Approvals, comments and the rest are moved with the file in one step
-- when it is renamed (see the rename route), and file_renames remembers every old name so
-- old links still open the file.
CREATE TABLE IF NOT EXISTS file_ids (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (client_slug, path)
);
INSERT OR IGNORE INTO file_ids (client_slug, path, created_at) SELECT client_slug, path, first_seen FROM files;
INSERT OR IGNORE INTO file_ids (client_slug, path, created_at) SELECT client_slug, path, updated_at FROM item_status;

CREATE TABLE IF NOT EXISTS file_renames (
  client_slug TEXT NOT NULL,
  old_path    TEXT NOT NULL,
  file_id     INTEGER NOT NULL,
  new_path    TEXT NOT NULL,
  renamed_by  TEXT NOT NULL,
  renamed_at  INTEGER NOT NULL,
  PRIMARY KEY (client_slug, old_path)
);

-- Replies: a reply points at the comment it answers (always the first comment of the thread).
ALTER TABLE comments ADD COLUMN parent_id INTEGER;
CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id);
