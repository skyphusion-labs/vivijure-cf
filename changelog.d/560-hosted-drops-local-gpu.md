### fix(deploy): the hosted studio no longer binds or deploys local-gpu (cf#560)

`local-gpu` was bound on the deployed hosted studio and, at `ui.order` 4, sorted FIRST in both
`motion.backend` and `keyframe` on the live registry -- while its own manifest blurb reads
*"Self-host only ... Commercial use of Vivijure is supported via vivijure-cf (Cloudflare partner
channels), not this door"*, and vivijure-cf IS the hosted deploy.

The control existed and was on the wrong path: `deploy.sh` (self-host, where the door is ALLOWED)
strips the `LOCAL-GPU` block unless `INSTALL_LOCAL_GPU=1`; the CI render (hosted, where it is
FORBIDDEN) had no strip at all. The path that permits it defaulted it off; the path that forbids it
had no switch. The hosted render now strips the block unconditionally and REFUSES to deploy if
`MODULE_LOCAL_GPU` survives, and the module-worker deploy excludes `local-gpu` by name rather than by
reintroducing an include-list (cf#197).

The survival check asserts the MODULE_ line DELTA is exactly 1, not merely that
`MODULE_LOCAL_GPU` is absent. An absence-only guard is one-sided: a removed or renamed CLOSING marker
leaves the strip running to EOF, and the guard passes because the binding really is gone -- driven at
481 lines -> 240 with MODULE_ 42 -> 4, and no downstream check catches it either, since every
downstream-guarded key sits above the truncation point.

