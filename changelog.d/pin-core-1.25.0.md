### chore(deps): pin `@skyphusion-labs/vivijure-core` to `^1.25.0` (cf#834, cf#856, cf#813)

Moves the studio onto core 1.25.0, which carries ten fragments including `core#306`
(`InvokeFailureReason`), `core#307` (assemble admission), `core#321`, `core#322` and `core#833`.

**`cf#834` IS A BEHAVIOUR CHANGE, NOT A BUGFIX, and it reaches users on this bump.** The post-clips
dialogue leg now **FAILS** what it cannot deliver instead of shipping a silent film booked as
complete, across **13 of 15 live motion doors** including `cf-seedance`. That is the fix, and it is
the last of the four "reports success without producing a film" defects. It also means **output that
currently `succeeds` will start failing wherever dialogue was being silently dropped.** A red render
downstream of this bump is the gate working, not a regression introduced by it.

Two more behaviour changes ride along and they are NOT the same condition, so do not collapse them:

- **`core#327`** -- an **unreachable** finish tier now delivers the declared clips rather than
  hard-failing.
- **`core#330`** -- a container that **answers and refuses** still fails **loud**.

Down and refusing are different states with different outcomes, which is the whole point.

**`cf#813` lands here too.** `core#322` matches the assemble delivery target to the measured source
instead of a fixed 1920x1080, so films stop being upscaled from whatever the door produced (12 of 15
installed doors were upscaled at default config) and a 4k source stops being destroyed to hit a
constant.

Three test assertions move with the pin because they encode behaviour that only exists at 1.25.0,
and each now asserts the NEW contract rather than merely flipping a boolean:

- **`core#321`** split `{unreachable: true}` from `null`. A transport failure and a 2xx answer with
  an unparseable body used to collapse to the same value, and only the first should trip the
  per-pass breaker. Both arms are pinned now, including a case added for the `null` arm.
- **`cf#856`** records `content_unmeasured` / `validated_unmeasured` when a gate could not run, so
  `changed` is now true on a skip. Measured on a live film at **5 skips, 0 passes**, with nothing
  anywhere recording that the pixel gate never looked at a single clip.

The fixture work this bump needed landed separately in the PR below it, so this change is the pin
plus those three assertions.
