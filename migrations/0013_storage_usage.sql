-- Per-object storage accounting ledger (core#52, the R2_STORAGE_QUOTA_BYTES operator knob).
--
-- One row per object in the renders bucket. The studio upserts a row on every write and drops it on
-- every delete, through the metering wrapper applied where studioEnv builds the request env
-- (src/orchestrator-env.ts). The quota check SUMs this table at submit.
--
-- KEYED ON THE OBJECT KEY, not a running total, and that is the load-bearing part: the film/clip job
-- docs are re-written to the SAME key on every advance tick, so an add-bytes-on-put counter would climb
-- on control docs alone and wedge a long-lived studio at its own ceiling. A rewrite UPDATES one row.
--
-- Accounting starts at the version that ships this: existing artifacts are not in the ledger, because
-- artifact SIZES are not derivable from the studio DB. POST /api/storage/reconcile rebuilds the ledger
-- from the bucket itself and is the one-time backfill as well as the drift repair.
--
-- The DDL below is STORAGE_USAGE_DDL from @skyphusion-labs/vivijure-core, verbatim; the two hosts share
-- one schema, and tests/storage-quota-wiring.test.ts fails if this file drifts from it.
CREATE TABLE IF NOT EXISTS storage_usage (
  object_key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
