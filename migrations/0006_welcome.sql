-- When each login was last sent its welcome email (null = never).
ALTER TABLE members ADD COLUMN welcomed_at INTEGER;
