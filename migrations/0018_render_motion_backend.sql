-- renders.motion_backend + renders.keyframe_backend (cf#393).
--
-- WHY. A completed render row carried quality_tier and clip_deliveries but not which motion
-- (or keyframe) backend produced the film. Searching the library for "own-gpu" or "seedance"
-- returned zero even when those backends had demonstrably rendered -- because the column did
-- not exist. Cost attribution and audit ("which backend rendered this film?") were unanswerable
-- from stored data.
--
-- WHY NOT parse clip keys. Clip/finish object keys are GPU-assigned tokens and are not
-- derivable from module names (vivijure-core film-model). A token that happens to equal a
-- module name is coincidence, not a contract. Do not build backend attribution on key parsing.
--
-- WHAT IS STORED. The RESOLVED module name known at submit time (e.g. "seedance", "own-gpu",
-- "keyframe"), the same value preflightRenderModules already validates. NULL means not
-- recorded: legacy rows predate the columns, keyframes-only previews may omit motion, and
-- from-keyframes / adopt paths may omit keyframe. Never backfill from keys.
--
-- Additive ADD COLUMN only -> rides normal auto-apply. No rewrite of existing rows.
ALTER TABLE renders ADD COLUMN motion_backend TEXT;
ALTER TABLE renders ADD COLUMN keyframe_backend TEXT;
