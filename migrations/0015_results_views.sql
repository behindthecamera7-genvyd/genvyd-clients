-- Who opened which campaign's Results page, and when (for the Claude feed: "Results viewed").
CREATE TABLE IF NOT EXISTS results_views (
  client_slug TEXT NOT NULL,
  path TEXT NOT NULL,
  email TEXT NOT NULL,
  first_viewed INTEGER NOT NULL,
  last_viewed INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_slug, path, email)
);
