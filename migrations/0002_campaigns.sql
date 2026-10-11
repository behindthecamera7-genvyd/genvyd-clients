-- Campaigns: Genvyd creates them per client, the client fills them with ads.
CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT NOT NULL,
  name        TEXT NOT NULL,
  notes       TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS campaigns_client ON campaigns(client_slug);

-- Which ads (file paths inside the client folder) are picked for each campaign.
CREATE TABLE IF NOT EXISTS campaign_items (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, path)
);
