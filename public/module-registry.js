// Vivijure studio -- the cross-page module registry (cf#580). ONE GET /api/modules per page
// load, shared by every script on the page that needs the projection.
//
// WHAT WAS MEASURED, with the denominator, because the issue as filed had it wrong. cf#580 says
// six call sites, three un-memoised. At the commit that added this file the population under
// public/ was SEVEN call sites, ONE memoised:
//
//   planner-registry.js:22   fetch("/api/modules")                     MEMOISED     planner
//   abuse-link.js:21         fetch("/api/modules")                     un-memoised  all 4 pages
//   readonly-gate.js:33      origFetch("/api/modules")                 un-memoised  all 4 pages
//   demo-steer.js:28         fetch("/api/modules")                     un-memoised  cast/modules/planner
//   hook-availability.js:48  var ready = fetch("/api/modules")         un-memoised  modules/planner
//   app.js:247               const res = await fetch("/api/modules")   un-memoised  modules
//   settings.js:347          fetch("/api/modules", { headers: ... })   un-memoised  settings
//
// TWO of those seven were invisible to the regex the previous test used, /fetch\("\/api\/modules"\)/:
// it demands a closing paren immediately after the string, so the two-argument call in settings.js
// does not match, and it demands a lowercase f, so origFetch in readonly-gate.js does not match
// either. A matcher that recognises only the shape it already knows can never report blindness to a
// different shape of the same call. That is why the count in the issue was short by two, and it is
// why the test replacing it derives the population by a UNION of matchers with a positive control.
//
// Per-page GET /api/modules BEFORE: planner.html 5, modules.html 5, cast.html 3, settings.html 3.
// AFTER: 1 on every page.
//
// ---------------------------------------------------------------------------------------------
// WHICH fetch THIS CALLS, and why it is bound at SCRIPT-EVAL time rather than resolved at call time.
//
// Two scripts patch window.fetch, in one fixed order that every studio page shares:
//
//   auth-token.js    loaded FIRST. Wraps window.fetch so every same-origin /api/* request carries
//                    Authorization: Bearer <token>. On an AUTH_MODE=token deploy a /api/modules
//                    request that skips this wrapper is unauthenticated and gets a 403.
//   readonly-gate.js loaded next. Keeps whatever window.fetch then is (the auth-token wrapper) as
//                    its own origFetch, and wraps it to block /api/* MUTATIONS client-side.
//
// This file loads BETWEEN those two and binds window.fetch at eval, so the function it binds is
// exactly the auth-token wrapper: byte-identical to the origFetch that readonly-gate.js captures one
// script later. Three consequences, all intended:
//
//   1. AUTH IS PRESERVED. Skipping the auth wrapper would break every token-mode deploy.
//   2. THE READ-ONLY SHIM IS BYPASSED rather than relied upon. GET sits on that shim SAFE list
//      today, so routing through it would also work -- silently, and on the strength of a list that
//      is not this file to maintain. Bypassing means a later change to what that gate blocks cannot
//      reach in here and turn a registry read into a synthetic 403.
//   3. NO RECURSION AND NO CHICKEN-AND-EGG. readonly-gate.js decides host.readonly FROM this very
//      read; routing it through the readonly wrapper would gate the request that decides the gate.
//
// Bound at eval and not at call ON PURPOSE: by call time window.fetch is the OUTERMOST wrapper,
// which reintroduces both (2) and (3). The script ordering this depends on is not left to a comment,
// it is asserted by a test that parses the script tags out of every public/*.html.
//
// NO SILENT FALLBACK. Several vitest suites eval panel scripts in plain Node, where window does not
// exist but a real global fetch does. Falling back to that global would RUN, would look like it
// worked, and would quietly issue one unauthenticated un-memoised request per caller: the exact
// defect this file removes, wearing the appearance of success. So the binding is allowed to be null
// and load() THROWS instead. A test hands in a transport explicitly via setTransport(). Same
// discipline as the pollPolicy() helper in demo-steer.js, and for the same reason.
//
// ---------------------------------------------------------------------------------------------
// THE MEMO CONTRACT. Carried over from planner-registry.js unchanged, because callers depend on all
// three parts of it:
//
//   - load() returns a SHARED promise. N callers before resolution share ONE in-flight request; a
//     resolved cache short-circuits with no fetch at all.
//   - load() NEVER REJECTS. A non-ok response or a transport throw caches the documented empty shape
//     { modules: [], hooks: {}, catalog: [] } and raises a failure flag. That is what lets every
//     read-only control degrade quietly instead of each growing its own catch.
//   - registryUnavailable() (cf#344) keeps "this studio has no modules" distinguishable from "I
//     could not ask". Those two are byte-identical in the cache and they name different parties, so
//     any caller that must NAME a module or refuse reads the flag. Preserved exactly, not collapsed.
//
// ONE ADDITION, present to avoid DEGRADING two callers rather than to grow the API.
// app.js and settings.js do not degrade quietly today: both reject on a non-ok response and show a
// message carrying the status, "/api/modules -> 503". A boolean flag alone would have forced both to
// drop the status out of copy a person actually reads. registryFailureReason() carries it. Purely
// additive; no existing reader behaviour moves.
//
// KEPT DELIBERATELY, and this is a decision rather than an omission: NO TTL AND NO RETRY, permanent
// for the life of the page.
//
//   The projection describes what the operator INSTALLED. It changes when someone deploys or edits
//   operator config, not while a reader sits on a page, so the page load is the honest refresh
//   boundary and a reload is the honest refresh. A TTL would re-open exactly the fan-out this file
//   closes, scaled by session length instead of by script count, to fix staleness nobody measured.
//   A retry would turn a studio having a bad minute into every open panel retrying in step: the same
//   synchronisation defect cf#515 took out of the render poll, rebuilt in a new place.
//
//   One staleness case checked rather than assumed: settings.js SAVES module config. It does so
//   against GET/PATCH /api/modules/:name/config, a different route, and the top-level projection
//   carries the module list and config_schema, which a config save does not alter. So no caller on
//   any of the four pages can currently observe a stale memo. If one ever can, the fix is an
//   explicit invalidate at the write, never a timer.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.moduleRegistry = api;
  }
})(
  typeof window !== "undefined" && window
    ? window
    : typeof self !== "undefined"
      ? self
      : this,
  function () {
    // The documented empty shape. Returned on BOTH failure paths, and the reason
    // registryUnavailable() has to exist: it is indistinguishable from a real empty studio.
    function emptyRegistry() {
      return { modules: [], hooks: {}, catalog: [] };
    }

    var cache = null;
    var loadPromise = null;
    var loadFailed = false;
    var failureReason = "";

    // Bound at EVAL time; see the header. Null under a plain-Node eval, which makes load() throw
    // rather than silently reach for a global fetch.
    var boundFetch = null;
    try {
      if (typeof window !== "undefined" && window && typeof window.fetch === "function") {
        boundFetch = window.fetch.bind(window);
      }
    } catch (e) {
      boundFetch = null;
    }

    // Explicit transport injection. The TEST seam, and the only supported way to drive this file
    // outside a browser. Resets nothing: a caller that sets a transport after a load has already
    // started is asking for the load already in flight, which is what it gets.
    function setTransport(fn) {
      boundFetch = typeof fn === "function" ? fn : null;
    }

    // Resolved at CALL time so the throw lands on the caller that needed the projection, naming the
    // file that is missing. Never substitutes a fallback: see NO SILENT FALLBACK in the header.
    function transport() {
      if (!boundFetch) {
        throw new Error(
          "module-registry.js: no fetch transport bound (no window at eval, and setTransport() " +
            "was never called); refusing to fall back to a global fetch (cf#580)",
        );
      }
      return boundFetch;
    }

    // Both guards below are inherited from planner-registry.js and both are kept for contract
    // fidelity, but they are NOT independent and a reader should not assume they are: loadPromise is
    // never cleared outside reset(), so the loadPromise guard alone already delivers one-flight AND
    // the cache short-circuit. Measured by mutation: removing EITHER guard on its own reddens
    // nothing, removing both reddens two tests. The cache guard is a cheaper synchronous path, not a
    // second line of defence, and a future change that starts clearing loadPromise is what would
    // turn it into one.
    function load() {
      if (cache) return Promise.resolve(cache);
      if (!loadPromise) {
        loadPromise = transport()("/api/modules")
          .then(function (r) {
            if (!r || !r.ok) {
              failureReason = "/api/modules -> " + (r ? r.status : "no response");
              return null;
            }
            return r.json();
          })
          .then(function (d) {
            if (!d) loadFailed = true;
            cache = d || emptyRegistry();
            return cache;
          })
          .catch(function (e) {
            loadFailed = true;
            failureReason = (e && e.message) || "transport failure";
            cache = emptyRegistry();
            return cache;
          });
      }
      return loadPromise;
    }

    // True only when a load COMPLETED and could not deliver the projection. False before any load
    // and false on a successful one, so a caller must await load() first -- reading it early answers
    // a question that has not been asked yet.
    function registryUnavailable() {
      return loadFailed;
    }

    // The status or transport message behind a failure; empty string when there was none. For the
    // two callers that show the reader a reason rather than degrading quietly.
    function registryFailureReason() {
      return failureReason;
    }

    // Whatever load() last resolved, or null before it resolves. For the SYNCHRONOUS helpers that
    // read the projection after their own await; never a substitute for awaiting load().
    function cached() {
      return cache;
    }

    // TEST SEAM ONLY. Clearing the memo inside a page re-opens the per-page fan-out this file
    // exists to close, so nothing under public/ calls it.
    function reset() {
      cache = null;
      loadPromise = null;
      loadFailed = false;
      failureReason = "";
    }

    return {
      load: load,
      cached: cached,
      registryUnavailable: registryUnavailable,
      registryFailureReason: registryFailureReason,
      setTransport: setTransport,
      reset: reset,
    };
  },
);
