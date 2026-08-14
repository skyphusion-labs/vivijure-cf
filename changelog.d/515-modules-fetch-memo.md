### fix(planner): stop the render-config panel double-fetching /api/modules (cf#515)

`planner-registry.js` exists so the planner reads `GET /api/modules` once; its own header says
"one fetch of GET /api/modules". `renderPanel()` in `planner-render-config.js` defeated it on
adjacent lines: it awaited the memoised `plannerRegistry.load()` and then issued its own
un-memoised `fetch("/api/modules")` for the same payload.

```js
await global.plannerRegistry.load();
const resp = await fetch("/api/modules");
```

Measured under `public/`: six direct `fetch("/api/modules")` call sites, exactly one memoised. Four
of the six load on `planner.html`, so one planner page load made four requests where the design says
one. This removes the one that is a pure duplicate; it is now three.

Behaviour-identical on both paths, and strictly more robust on one. `load()` returns the same
`{modules, hooks, catalog, render}` payload and degrades to the same empty shape on a non-ok
response, and it also CATCHES a transport throw, which the bare fetch did not.

It removes a real inconsistency rather than only a request: this panel could previously render a
DIFFERENT registry snapshot than every other planner control, because the others all read the memo
and this one re-fetched.

**Corrected in the de-escalating direction:** this is NOT a per-poll fan-out. `renderPanel()` is
called once, from `planner-init.js`, at init; no poll loop touches it. It is a per-page-load cost.

**Declared out of scope, with the reason:** `abuse-link.js`, `hook-availability.js` and
`demo-steer.js` also read `/api/modules`, and each loads on pages that do not ship
`planner-registry.js` (`cast.html`, `modules.html`, `settings.html`), so they cannot route through
the planner memo without a new shared primitive. Measured, left alone deliberately, and asserted by
a test so their absence from this change reads as a decision.

Refs #515
