-- Small key/value store for the email digest (which activity was already emailed).
CREATE TABLE IF NOT EXISTS notify_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
