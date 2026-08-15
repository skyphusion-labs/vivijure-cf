### fix(panel): one GET /api/modules per page load, not five (cf#580)

Every studio page fetched the module registry once per script that needed it. `planner.html` and
`modules.html` made FIVE `GET /api/modules` per load; `cast.html` and `settings.html` made three.
The projection is the same bytes every time, so four of those five were pure duplicate work, and
the panel could render two controls against two different snapshots of the same registry.

`public/module-registry.js` is the shared one-flight memo, loaded on all four pages. Every page now
makes exactly ONE request. `planner-registry.js` keeps the planner-facing helpers and DELEGATES to
it rather than keeping a second memo, because two memos on one page is this defect relocated, not
fixed.

**The issue as filed undercounted, and how it undercounted is the interesting part.** cf#580 says
six call sites, three un-memoised. The measured population was SEVEN, one memoised. The two extra
were not hiding; they were invisible to the matcher the previous test used,
`/fetch\("\/api\/modules"\)/`, which demands a closing paren immediately after the URL string and a
lowercase `f`:

```js
readonly-gate.js:33   origFetch("/api/modules")                    // callee is not "fetch"
settings.js:347       fetch("/api/modules", { headers: ... })      // a second argument
```

A regex that matches only the shape it already knows can never reveal blindness to a different
shape of the same call, so its zero was a statement about the regex. The replacement suite derives
the population by a UNION of three independent matchers over a file list read off the filesystem,
with a positive control per call shape and an explicit proof that the old matcher is blind to three
of the five shapes tested. The suite prints its denominators: `1 of 37 public/*.js`, and per page,
`1 of 33` scripts on planner.html.

Per-page `GET /api/modules`, before and after: planner.html 5 to 1, modules.html 5 to 1, cast.html
3 to 1, settings.html 3 to 1.

**The memo contract is preserved exactly, including the parts that are load-bearing.** `load()`
returns a shared promise (N concurrent callers, one request); it NEVER rejects, which is what lets
six callers drop their own `.catch` and degrade quietly; and `registryUnavailable()` (cf#344) still
distinguishes "this studio has no modules" from "I could not ask", because those two are
byte-identical in the cache and they name different parties. `hook-availability.js` reads that flag
rather than the payload, which is the difference between preserving its behaviour exactly and
preserving it approximately: without the flag a failed read would have run its document sweep,
which the old `.catch` never did.

**One addition, to avoid degrading two callers rather than to grow the API.** `app.js` and
`settings.js` do not degrade quietly; both showed the reader a message carrying the status,
`/api/modules -> 503`. A boolean flag alone would have forced both to drop the status out of copy a
person actually reads, so `registryFailureReason()` carries it.

**Kept deliberately, and stated so it reads as a decision: no TTL and no retry, permanently.** The
projection describes what the operator INSTALLED, which changes on a deploy or a settings edit and
not while a reader sits on a page, so the page load is the honest refresh boundary and a reload is
the honest refresh. A TTL would re-open exactly the fan-out this closes, scaled by session length
instead of by script count, to fix staleness nobody measured. A retry would turn a studio having a
bad minute into every open panel retrying in step, which is the synchronisation defect cf#515 took
out of the render poll, rebuilt in a new place. One staleness case was checked rather than assumed:
`settings.js` saves module config, but against `GET/PATCH /api/modules/:name/config`, a different
route, and the top-level projection carries the module list and `config_schema`, which a config
save does not alter.

**Load order is part of the change, not decoration.** `module-registry.js` loads between
`auth-token.js` and `readonly-gate.js` on every page and binds `window.fetch` at eval, so the
transport it holds is the auth-token wrapper: the same function `readonly-gate.js` already captured
as its `origFetch`. That keeps the bearer header, bypasses the read-only shim rather than relying
on GET sitting on its SAFE list, and avoids gating the request that decides the gate. A test parses
the script tags out of every `public/*.html` and asserts the ordering.

**It refuses rather than falling back.** Several vitest suites eval panel scripts in plain Node,
where `window` does not exist but a global `fetch` does. Falling back to that global would run, look
like it worked, and quietly issue one unauthenticated un-memoised request per caller, which is this
defect wearing the appearance of success. So the binding is allowed to be null and `load()` throws;
tests hand in a transport explicitly. `planner-registry.js` throws on the same grounds when the
shared file is missing, instead of rebuilding its own memo.

Refs #580
