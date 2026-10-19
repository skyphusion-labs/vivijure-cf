-- Vivijure Studio -- PUBLIC DEMO STUDIO. DEMO D1 ONLY. NEVER prod.
--
-- Lives under migrations/demo/ ON PURPOSE: a subdirectory `wrangler d1 migrations apply` does NOT
-- scan, so it can NEVER auto-apply to the production DB. Apply EXPLICITLY on the demo D1:
--   wrangler d1 execute <demo-db> --file=migrations/demo/0006_drop_finish_lipsync.sql
--
-- Why: MuseTalk is ruled out permanently as a lip-sync provider (cf#783), its RunPod endpoint no
-- longer exists, and the finish-lipsync module that clients it is removed from this repo. 0001 used
-- to seed a catalog row; that seed is removed for fresh installs, but the LIVE demo D1 already has
-- the row from an earlier 0001 apply, and 0001 is INSERT OR IGNORE so a re-apply will not remove it.
-- This DELETE drops the retired module from the demo catalog so the public shop window stops
-- advertising a finish step that cannot run.
--
-- Lip-sync itself is NOT retired: infinitetalk is the live audio-driven path, and it is a
-- motion.backend door rather than a finish module, so nothing here touches it.
--
-- Idempotent: a re-apply is a no-op once the row is gone. Does not touch any other table.

DELETE FROM installed_modules WHERE name = 'finish-lipsync';
