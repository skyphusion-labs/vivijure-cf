-- FIFO admission to the video-finish tier. See src/finish-queue.ts in vivijure-core.
-- tests/finish-queue-migration.test.ts holds this file equal to FINISH_QUEUE_SCHEMA.
CREATE TABLE IF NOT EXISTS finish_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  holder TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'leased', 'parked')),
  step TEXT,
  fairness_key TEXT,
  asked_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  lease_expires INTEGER
);
CREATE INDEX IF NOT EXISTS idx_finish_queue_state_seq ON finish_queue (state, seq);
CREATE TABLE IF NOT EXISTS finish_queue_cap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cap INTEGER NOT NULL,
  until INTEGER NOT NULL
);
