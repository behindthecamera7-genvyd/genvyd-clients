-- Invoices: the PDFs live on the Synology in "<client folder>/Invoices/". This table keeps what the
-- portal adds to each one: details typed in by Genvyd (when the file name does not carry them),
-- the card payment link, paid / void, and when the client first opened it.
CREATE TABLE IF NOT EXISTS invoices (
  client_slug TEXT NOT NULL,
  path TEXT NOT NULL,
  number TEXT,
  amount_cents INTEGER,
  issued TEXT,
  due TEXT,
  description TEXT,
  pay_link TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  paid_on TEXT,
  paid_method TEXT,
  paid_note TEXT,
  first_seen INTEGER,
  first_viewed INTEGER,
  first_viewed_by TEXT,
  last_viewed INTEGER,
  updated_by TEXT,
  updated_at INTEGER,
  PRIMARY KEY (client_slug, path)
);

-- Small studio-wide settings (how clients pay: check details, card service fee).
CREATE TABLE IF NOT EXISTS portal_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER
);
