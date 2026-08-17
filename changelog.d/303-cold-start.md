### fix(render): show cold start vs stall (cf#303)

The film poll already carries `IN_QUEUE` (module `wait=accepted`) and
the direct RunPod path already carries `delayTimeMs`. The live panel
ignored both: it hid the progress widget for the whole queue wait, then
inferred "startup" from "keyframe with nothing drawn", so a spinning-up
worker and a running encode (or a stall) still read the same.

The panel now reads the poll. `IN_QUEUE` / `delayTime` / `accepted`
shows "Starting up" and the startup note. A running encode shows
"Rendering" and no note. The stall verdict still replaces the note.
No raw `IN_QUEUE` in the visible text; the token stays on the title.
The bar still does not invent motion.
