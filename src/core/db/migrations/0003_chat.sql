-- M4: chat message lifecycle and per-reply metadata (provider, attempts, latency, reasoning).

ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'
  CHECK (status IN ('complete', 'streaming', 'error', 'stopped'));
ALTER TABLE messages ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
