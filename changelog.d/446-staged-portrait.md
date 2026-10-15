### fix(cast-media): collect the superseded portrait on the staged-key path

The JSON `{ key, mime }` branch of `handleCastPortraitUpload` wrote the row
and returned, so every panel-staged portrait replacement left the previous
object in the bucket with nothing pointing at it. The chat-artifact and
raw-bytes branches already call `deleteSupersededPortrait` after the row
write, and only when that write returned a row. The staged-key branch now
does the same. The helper still returns immediately when the old key is
empty or equal to the new key, so a same-key re-register does not delete
the object just registered. No bucket sweep.

Parity with vivijure-local#446.
