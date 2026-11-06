### fix(animate): refuse a per-shot door map with a door driven by a line's audio

`animate-cloud` and `animate-hybrid` with a per-shot door map now answer 400 when the shots do not all use the default door and any door involved has `usage.driving_audio`. Core decides pre-clip dialogue from the default door alone, so such a film either lost its map after pre-clip dialogue or sent an audio-driven shot no audio, after money was spent. One door for every shot, and maps with no audio-driven door, start as before (vivijure-cf#1168). The full fix is tracked in skyphusion-labs/vivijure-core#442.
