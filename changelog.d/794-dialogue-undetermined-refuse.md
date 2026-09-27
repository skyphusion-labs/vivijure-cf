### fix(render): refuse a render whose dialogue state is undetermined (cf#794)

A swallowed dialogue-derivation failure left `dialogue` undefined, so
`spokenLinesPresent` read false, the talking-door 400 never fired, and a voiced
storyboard rendered SILENT and returned 201, reintroducing what cf#334 fixed.
`readBundleScenes` returns `[]` for a missing bundle and throws only on a real
failure, so the three derivation sites now refuse with 503 and the cause instead
of guessing silence; a genuinely silent storyboard still renders. Same block:
`voiceMap` was hardcoded `{}` although the preflight exposes `voices`, so every
panel render spoke in `DEFAULT_VOICE_ID` even with a cast voice resolved.
