-- Vivijure Studio -- PUBLIC DEMO STUDIO. DEMO D1 ONLY. NEVER prod.
--
-- Lives under migrations/demo/ ON PURPOSE: a subdirectory `wrangler d1 migrations apply` does NOT
-- scan, so it can NEVER auto-apply to the production DB. Apply EXPLICITLY on the demo D1:
--   wrangler d1 execute <demo-db> --file=migrations/demo/0007_drop_speech_upscale.sql
--
-- Why: speech-upscale is removed (cf#786). Its RunPod endpoint no longer exists (cf#757), so it was
-- bound to nothing while the finish tier booked the degrade as `completed`; its only planner trigger
-- was the finish-lipsync checkbox removed with MuseTalk (cf#783); and its purpose was cleaning
-- dialogue BEFORE post-hoc mouth replacement, which no longer happens at all. 0001 used to seed a
-- catalog row; that seed is removed for fresh installs, but the LIVE demo D1 already has the row
-- from an earlier 0001 apply, and 0001 is INSERT OR IGNORE so a re-apply will not remove it. This
-- DELETE drops the retired module from the demo catalog so the public shop window stops advertising
-- a speech step that cannot run.
--
-- Idempotent: a re-apply is a no-op once the row is gone. Does not touch any other table.

DELETE FROM installed_modules WHERE name = 'speech-upscale';
