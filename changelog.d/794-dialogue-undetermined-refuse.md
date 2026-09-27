### fix(render): refuse a render whose dialogue state is undetermined (cf#794)

**Behaviour change: a submit that used to return 201 can now return 503.** If the
panel cannot establish whether a storyboard has spoken lines, the render is
refused instead of started. Previously it was started and could come back as a
finished, silent film reported as a success.

A swallowed dialogue-derivation failure left `dialogue` undefined, so
`spokenLinesPresent` read false, the talking-door 400 never fired, and a voiced
storyboard rendered SILENT and returned 201, reintroducing what cf#334 fixed.
`readBundleScenes` returns `[]` for a missing bundle and throws only on a real
failure, so the three derivation sites (panel render, render-from-keyframes,
finalize/animate) now refuse with 503 and carry the underlying cause. A
genuinely silent storyboard is unaffected and still renders: a missing bundle
returns `[]` rather than throwing, so nothing that used to work silently breaks.

The 503 names the reason, so a corrupt bundle reads as a corrupt bundle rather
than as a transient blip worth retrying forever.

Same block: `voiceMap` was hardcoded `{}` although the preflight exposes
`voices`, so every panel render spoke in `DEFAULT_VOICE_ID` even when the cast
member had a voice resolved.
