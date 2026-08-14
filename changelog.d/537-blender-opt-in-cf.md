### feat(finish): blender is opt-in, and both render doors carry the selection (cf#537)

The cf half of Conrad's cf#537 ruling: per-render, the caller names which finish modules run.
`finish-blender` declares `participation: "opt_in"` so a render that does not name it does not get an
unrequested `filmic_warm` grade at strength 1.0. Both render doors carry the selection, and the
replay paths inherit it via `renderOverrides` so no caller and neither store-shipped native client
needs to change.

Repins core to `^1.14.0` WITH the regenerated lockfile, and updates the five `filmProgressMarker`
assertions from the two-part `phase:count` to core#182's three-part `phase:done:steps`. The repin and
those five fixes must land together: `npm ci` refuses a package.json/lockfile disagreement, and the
repin alone reddens cf on assertions this change is what corrects.
