-- Vivijure Studio -- cast Wan LoRA keys (migration 0012).
--
-- A Wan 2.2 A14B character LoRA is a two-expert mixture (high-noise + low-noise), so it needs TWO
-- adapter keys beside the single-file lora_key. These columns are additive; lora_status,
-- lora_job_id, lora_error, and lora_trained_at stay SHARED with the SDXL path (a cast trains one
-- family at a time). Both NULL until a Wan train completes -- markWanLoraReady (vivijure-core
-- cast-db) sets them together. Pairs with the @skyphusion-labs/vivijure-core Phase-B change (cf#29).
--
-- Migrations are filename-tracked (each runs once), and ADD COLUMN is additive, so this is safe on
-- the auto-apply-all-migrations-on-tag path: the currently-published core simply ignores the new
-- columns until the Phase-B core version publishes and reads them.

ALTER TABLE cast_members ADD COLUMN wan_lora_key_high TEXT;   -- Wan high-noise expert adapter key
ALTER TABLE cast_members ADD COLUMN wan_lora_key_low  TEXT;   -- Wan low-noise expert adapter key
