-- Vivijure Studio -- PUBLIC DEMO STUDIO. DEMO D1 ONLY. NEVER prod.
--
-- Lives under migrations/demo/ ON PURPOSE: a subdirectory `wrangler d1 migrations apply` does NOT
-- scan, so it can NEVER auto-apply to the production DB. Apply EXPLICITLY on the demo D1:
--   wrangler d1 execute <demo-db> --file=migrations/demo/0005_beat_sync_door_copy.sql
--
-- Why: 0001 used to seed beat-sync's provides label as "Beat sync (librosa, fleet VPC)".
-- Doors are Traefik public HTTPS URLs now. Fresh installs get the new string from 0001;
-- the LIVE demo D1 still has the old JSON because 0001 is INSERT OR IGNORE. This REPLACE
-- updates the catalog row so the public shop window stops advertising VPC.
--
-- Idempotent: a re-apply is a no-op once the old phrase is gone.

UPDATE installed_modules
SET manifest = REPLACE(manifest, 'Beat sync (librosa, fleet VPC)', 'Beat sync (librosa)')
WHERE name = 'beat-sync'
  AND instr(manifest, 'Beat sync (librosa, fleet VPC)') > 0;
