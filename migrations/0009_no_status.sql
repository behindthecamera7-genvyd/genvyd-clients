-- Adds the "No" status ('rejected') for ads the client does not want.
-- SQLite cannot change a CHECK constraint, so the table is rebuilt.
-- item_status has no foreign keys pointing at it and no extra indexes.
CREATE TABLE item_status_new (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','approved','changes','rejected')),
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path)
);
INSERT INTO item_status_new (client_slug, path, status, updated_by, updated_at)
  SELECT client_slug, path, status, updated_by, updated_at FROM item_status;
DROP TABLE item_status;
ALTER TABLE item_status_new RENAME TO item_status;
