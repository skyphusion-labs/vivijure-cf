-- Preview clip the filmmaker kept as the talking-door voice lock.
-- Seedance receives this as reference_video. Veo cannot use it.
ALTER TABLE cast_members ADD COLUMN voice_ref_key TEXT;
