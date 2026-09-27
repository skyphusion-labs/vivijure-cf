### fix(test): follow core 1.23.0 making a mux transport failure fail loud (cf#810 pin bump)

Surfaced by bumping `@skyphusion-labs/vivijure-core` to `^1.23.0`, which is the point of putting the
bump in the same change as the code that needs it.

Core 1.23.0 carries *"fix(mux): a transport failure is a failure, not a silent film shipped as
COMPLETED"* (refs cf#746). `enterMuxPhase` answered `tick.kind === "failed"` by degrading to `done`
with the silent film, while `enterAssemblePhase` answered the identical condition with
`phase = "failed"` -- ten lines apart, opposite outcomes, and the mux one was terminal: the job read
COMPLETED and the audio was never coming. `submitAsync` gives up on the first attempt with no retry,
so a single transient blip permanently converted a film-with-audio into a silent film reported as
complete.

The cf test asserting the old degrade is updated to assert the failure. Note its TITLE already said
"STILL FAILS LOUD (#245/#249)" -- the title was right and the assertion had drifted from it, which is
why this reads as the test catching up rather than being relaxed. It now matches its assemble sibling
twenty lines above it.

Both legitimate mux degrades are unchanged and still covered by their own tests: `VIDEO_FINISH_URL`
unset (the tier is not installed, #519) and `hasAudio:false` (the container ran and reported the bed
unusable). The rule the two legs now share is degrade when a retry cannot help, fail when it can.

Also in this bump: core brands the recoverable finish-shot states (GHSA-hcr9-8jc2-9q4c), so
`adoptFinishStepOutput` takes a `RecoverableFinishShot` obtainable only through
`finishShotRecoverable`. Two fixtures narrow through that guard instead of casting past it -- a cast
would be the test opting out of the guarantee the brand exists to provide, and would keep passing if
the guard broke.
