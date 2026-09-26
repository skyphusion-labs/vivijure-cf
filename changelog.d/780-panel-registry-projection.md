### fix(planner): project the finish picks from the registry, and derive the guard corpus (#780)

The opt-in finish controls were a hand-kept `[module, wrapperId]` pair list
against two static checkboxes, so an installed, conformant `finish` module
declaring `participation: "opt_in"` that was not `finish-lipsync` or
`finish-blender` got no control at all and could never be named in the submit.
They are now projected: one checkbox per opt_in `finish` module, in registry
order, each labelled from that module's own `provides[0].label`. A new opt_in
finish module needs no edit to the panel or to `planner.html`.

The picks are built after the registry resolves, while draft restore runs at
load, so restore now parks its map and the first build applies it; the static
markup it replaced was present from parse time and had no such window. The
saved draft carries a `finishPicks` map keyed by module name instead of one
scalar field per module, with a declared shim reading the two old keys.

`tests/panel-no-hardcoded-modules.test.ts` pinned six cloud `motion.backend`
names and was green because none of them appeared, while seven other module
names were compiled into the panel across 21 sites. Its corpus is now DERIVED
from the installed module set (hook-name collisions subtracted, also derived),
and the exemptions are a ratchet: an undeclared name fails, and a declared one
that has been paid off fails too, so the list can neither grow silently nor
rot. Remaining hardcoded names are down to 6 across 11 sites, every one of them
declared with a reason and a way out.

Also: two comments in `public/render-eta.js` cited `src/film-render-bridge.ts`
for `phaseProgress`, which lives in core; that file is a re-export shim and does
not carry it. And `bundle-out/` is untracked and ignored -- wrangler regenerates
it on every tagged release run, so the copy committed on 2026-07-24 was 30+
releases stale and shadowed core's real source in a grep.
