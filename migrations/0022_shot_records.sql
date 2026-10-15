-- One row per shot. The film job document in R2 remains the orchestrator's copy.
-- This row is the step record: which of still, wav, or clip is in progress, and the
-- R2 key of each artifact that has landed. The bytes stay in R2.
CREATE TABLE IF NOT EXISTS shot_records (
  film_id    TEXT    NOT NULL,
  shot_id    TEXT    NOT NULL,
  still_key  TEXT,
  wav_key    TEXT,
  clip_key   TEXT,
  step       TEXT    NOT NULL,
  step_error TEXT,
  step_token TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (film_id, shot_id)
);
