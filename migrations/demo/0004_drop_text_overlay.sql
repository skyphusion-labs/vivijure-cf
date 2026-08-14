-- Vivijure Studio -- PUBLIC DEMO STUDIO. DEMO D1 ONLY. NEVER prod.
--
-- Lives under migrations/demo/ ON PURPOSE: a subdirectory `wrangler d1 migrations apply` does NOT
-- scan, so it can NEVER auto-apply to the production DB. Apply EXPLICITLY on the demo D1:
--   wrangler d1 execute <demo-db> --file=migrations/demo/0004_drop_text_overlay.sql
--
-- Why: the text-overlay finish module was retired (vivijure#769; superseded by subtitle +
-- film-titles). 0001 used to seed a catalog row; that seed is removed for fresh installs, but the
-- LIVE demo D1 already has the row from an earlier 0001 apply, and 0001 is INSERT OR IGNORE so a
-- re-apply will not remove it. This DELETE drops the retired module from the demo catalog so the
-- public shop window stops advertising dead code (cf#24).
--
-- Idempotent: a re-apply is a no-op once the row is gone. Does not touch any other table.

DELETE FROM installed_modules WHERE name = 'text-overlay';
