### fix(planner): stop the render-config panel double-fetching /api/modules (cf#515)

`planner-registry.js` exists so the planner reads `GET /api/modules` once; its own header says
"one fetch of GET /api/modules". `renderPanel()` in `planner-render-config.js` defeated it on
adjacent lines: it awaited the memoised `plannerRegistry.load()` and then issued its own
un-memoised `fetch("/api/modules")` for the same payload.

```js
await global.plannerRegistry.load();
const resp = await fetch("/api/modules");
```

Measured under `public/`: six direct `fetch("/api/modules")` call sites, exactly one memoised. Five
of the six load on `planner.html` (every one except `app.js`), so one planner page load made five
requests where the design says one. This removes the one that is a pure duplicate; it is now four.

Behaviour-identical on both paths, and strictly more robust on one. `load()` returns the same
`{modules, hooks, catalog, render}` payload and degrades to the same empty shape on a non-ok
response, and it also CATCHES a transport throw, which the bare fetch did not.

It removes a real inconsistency rather than only a request: this panel could previously render a
DIFFERENT registry snapshot than every other planner control, because the others all read the memo
and this one re-fetched.

**Corrected in the de-escalating direction:** this is NOT a per-poll fan-out. `renderPanel()` is
called once, from `planner-init.js`, at init; no poll loop touches it. It is a per-page-load cost.

**Declared out of scope, with the reason, corrected:** `abuse-link.js`, `hook-availability.js`
and `demo-steer.js` also read `/api/modules`. All three DO load on `planner.html` alongside
`planner-registry.js`, so the barrier is not that the memo is unavailable to them there; it is that
each ALSO loads on pages that do not ship the registry (`cast.html`, `modules.html`,
`settings.html`), so none of them can depend on it unconditionally without a new shared primitive.
All three issue the request at IIFE entry and gate only after the response, so each is a real
request on a planner page load. Measured, left alone deliberately, and asserted by a test so their
absence from this change reads as a decision.

Refs #515
