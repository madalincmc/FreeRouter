-- Providers can now be off by default (profile `defaultEnabled: false`). Remember which
-- providers the user switched on or off, so a catalog default never overrides their choice.
ALTER TABLE providers ADD COLUMN enabled_by_user INTEGER NOT NULL DEFAULT 0;

-- Every provider used to start enabled, so a disabled one was the user's choice.
UPDATE providers SET enabled_by_user = 1 WHERE enabled = 0;
