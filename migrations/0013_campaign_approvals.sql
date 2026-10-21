-- Campaign summaries ("<Campaign>.summary.md" anywhere in a client folder) and their approvals.
-- campaign_summaries: where the portal has seen a summary file (found by folder listings and the scan).
CREATE TABLE IF NOT EXISTS campaign_summaries (
  client_slug TEXT NOT NULL,
  path TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_sig TEXT,
  last_checked INTEGER,
  gone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_slug, path)
);

-- campaign_events: the audit trail. One row per approval, change request or automatic reset.
-- Append only: the triggers below refuse any UPDATE or DELETE, so a record can never be edited.
CREATE TABLE IF NOT EXISTS campaign_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT NOT NULL,
  summary_path TEXT NOT NULL,
  campaign TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('approved', 'changes', 'reset')),
  email TEXT,
  typed_name TEXT,
  comment TEXT,
  at INTEGER NOT NULL,
  at_utc TEXT NOT NULL,
  at_phoenix TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  summary_sha256 TEXT,
  sig TEXT,
  files_json TEXT,
  frozen_text TEXT,
  agreement_text TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS campaign_events_by_summary ON campaign_events (client_slug, summary_path, id);

CREATE TRIGGER IF NOT EXISTS campaign_events_no_update BEFORE UPDATE ON campaign_events
BEGIN SELECT RAISE(ABORT, 'Campaign approval records cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS campaign_events_no_delete BEFORE DELETE ON campaign_events
BEGIN SELECT RAISE(ABORT, 'Campaign approval records cannot be deleted.'); END;
