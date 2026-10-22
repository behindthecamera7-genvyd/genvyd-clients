-- Which ad files (every placement and version) and copy files a campaign summary covers, saved each
-- time the summary is read, so the client's home page does not list them again as separate to-dos.
ALTER TABLE campaign_summaries ADD COLUMN covered TEXT;
