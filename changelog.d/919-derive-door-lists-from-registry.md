### fix(panel): derive the talking-door lists from the installed modules, not from a literal (cf#919)

Two hardcoded lists told a filmmaker to pick doors this deploy does not have. On a hosted tenant both
named **InfiniteTalk**, which is not in `TENANT_MODULE_CATALOG` and cannot be installed there, so the
product surface named a door that is not in the picker.

- **The spoken-lines refusal**, byte-identical at three render doors (`src/index.ts` panel,
  render-from-keyframes, agent), was a literal naming seven doors while the predicate it guards
  (`doorCanSpeakLines`) read the live module set one line above it. It now calls
  `spokenLinesRefusalMessage(modules, chosen, audioOn)`, which projects the remedy from
  `servingForHook(modules, "motion.backend")` filtered by that same predicate.
- **`TALKING_VOICE_HONOR`**, shipped to the cast voice picker as `talking_doors` on `GET /api/voices`,
  is now projected through the installed serving set by `talkingVoiceHonorFor`. `catalogForDeploy`
  already refused to advertise capability a DEMO deploy lacks; this is that rule one deploy mode over,
  except the authority is the live registry rather than a mode flag. Deploy mode does not scrub it.

**Also fixed, same message, found while rewriting it:** the guard is `(door cannot speak) OR (talking
audio off)` and ONE sentence served both causes, so a filmmaker who had already chosen the right door
was told to go choose a different one. Three states now get three sentences, including an honest
"this studio has no talking door installed" instead of an empty parenthetical.

`moduleLabel` (`src/module-catalog.ts`) is exported rather than copied, so the refusal names a door
the same way the catalog rows do; a second copy of that rule is how two surfaces start calling one
module different things. `public/cast.js` gained an authored empty state, because an empty
`talking_doors` is now a real answer rather than only a failed fetch.

**Watched red before the fix, not after.** The route assertion in
`tests/render-film-dialogue.test.ts` failed against the unfixed code with the live literal printed
(`expected 'This storyboard has spoken lines. Pic...' not to match /infinitetalk/i`), in an env whose
only bound talking door is `seedance`. Then the control of the control: re-hardcoding
`talkingDoorLabels` to return the old seven names fails **8 of 14** cases in
`tests/door-lists-projected-919.test.ts`, and the 6 that survive are the honor-table and audio-switch
branches a door list cannot affect. The assertions are written about doors ABSENT from the installed
set, because the present-door half is what a literal passes by accident.

`tests/auth-gate.test.ts` now binds one talking door (`cf-seedance`) in both the demo and token envs
and asserts the NEGATIVE half: `cf-veo` and `infinitetalk` are rows in the table, are not bound, and
must not appear. Without a bound door the projection would be trivially empty and the test could not
tell "projected" from "nothing installed" -- the same reasoning the neighbouring
`planEnhanceBinding` comment already gives for the planning catalog.

**Fixture correctness, worth recording:** `parseMotionUsage` rejects a PARTIAL `usage` block and
discovery then drops the module entirely, so a stub like `usage: { native_audio: true }` is a module
production cannot produce and it silently tested nothing. Every fixture here carries a full
`MotionUsageDecl`.

Docs: `docs/CONTRACT.md` 2.4 records that `talking_doors` is projected (and can be empty), and the
2.20 refusal text is replaced by the three-state table plus a note that a client must not match on the
old literal.

**Scope of the two lists, measured rather than assumed.** Reading the `usage` block of each of the 17
`motion.backend` manifests in `modules/` (a file-wide grep for `native_audio: true` is wrong here: it
reports `kling`, `minimax-hailuo` and `cf-hailuo` as talking, and all three declare `native_audio:
false` inside `usage`), there are **9** talking doors: `alibaba-wan`, `cf-flux-3-video`,
`cf-grok-video`, `cf-seedance`, `cf-veo`, `google-veo`, `infinitetalk`, `seedance`, `vidu-q3`. The 9
`TALKING_VOICE_HONOR` rows are exactly those 9, so that table was never wrong about WHICH doors talk;
it was wrong to ship all 9 to a deploy that installs fewer. The retired literal named seven, which
also collapsed the Cloudflare and RunPod pairs of one vendor into a single word.

**Not claimed:** whether a hosted tenant can install InfiniteTalk is a control-plane question moving
in parallel (`strummer` on cp#, cf#919's chain). This change makes the panel tell the truth about
whatever set is installed; it does not decide what that set should be.
