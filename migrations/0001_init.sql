-- Clients. `folder` is the folder name inside the Synology share.
CREATE TABLE IF NOT EXISTS clients (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  folder      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Who can log in and see a client. One email can belong to several clients.
CREATE TABLE IF NOT EXISTS members (
  client_slug TEXT NOT NULL REFERENCES clients(slug) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (client_slug, email)
);
CREATE INDEX IF NOT EXISTS members_email ON members(email);

-- Approval state per file. Files with no row are "pending".
CREATE TABLE IF NOT EXISTS item_status (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','approved','changes')),
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path)
);

CREATE TABLE IF NOT EXISTS likes (
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (client_slug, path, email)
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  email       TEXT NOT NULL,
  body        TEXT NOT NULL,
  timecode    REAL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_item ON comments(client_slug, path);

-- Feed of everything clients do, for the admin page.
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT NOT NULL,
  path        TEXT NOT NULL,
  email       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_time ON activity(created_at);
