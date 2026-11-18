-- Stripe: the checkout made for each invoice and where its payment stands.
ALTER TABLE invoices ADD COLUMN stripe_session TEXT;
ALTER TABLE invoices ADD COLUMN stripe_status TEXT;
ALTER TABLE invoices ADD COLUMN stripe_payment TEXT;

-- Stripe connection details (the webhook endpoint and its signing secret). Kept out of the
-- portal backups on purpose: a restore never wipes it and backups never carry the secret.
CREATE TABLE IF NOT EXISTS stripe_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);
