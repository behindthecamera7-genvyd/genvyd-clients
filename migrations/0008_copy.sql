-- Ad copy for client approval: taglines, headlines, primary text, CTAs. Comments on a copy
-- line live in `comments` with path "copy:<id>", so the dashboard, digest and resolve work.
CREATE TABLE IF NOT EXISTS copy_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- tagline, headline, primary, cta, caption, other
  text        TEXT NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes')),
  status_by   TEXT,
  status_at   INTEGER,
  version     INTEGER NOT NULL DEFAULT 1,
  history     TEXT NOT NULL DEFAULT '[]', -- JSON: earlier wordings [{text, by, at}]
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_items_client ON copy_items(client_slug);
CREATE TABLE IF NOT EXISTS copy_campaigns (
  copy_id     INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (copy_id, campaign_id)
);
