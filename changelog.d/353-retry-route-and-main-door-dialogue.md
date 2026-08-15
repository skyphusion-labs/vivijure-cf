### feat(render): real retry route, and the main door derives dialogue from the bundle (cf#353, cf#334)

Adds the real retry route (cf#353), and makes the panel's main Render button derive dialogue from the
bundle storyboard when the panel omits `dialogue_lines`, so a voiced storyboard no longer ships silent
from door 1 (cf#334).

The door ledger declares door 1's dialogue capability as `yes` rather than `internal`. `internal` is an
exemption: the ledger's per-door assertion skips the observed-vs-declared comparison for it, so the
only test covering this feature stopped comparing at the exact moment the feature was added. Declaring
`yes` restores the comparison -- deleting the derivation now fails with
`1 panel MAIN render.dialogue: declared yes, observed false`, and passes with it intact.
