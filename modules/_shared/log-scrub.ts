// POINTER, NOT AN IMPLEMENTATION. The content-free log vocabulary lives in src/log-scrub.ts (cf#223).
//
// ------------------------------------------------------------------------------------------------
// WHY THIS FILE EXISTS. cf#223 stage 1 built one vocabulary for turning user content into a
// content-free label (`shortId`, `keyLabel`, `untrustedLabel`) and put it in the HOST at
// src/log-scrub.ts. Module workers are separate wrangler builds and import `../../_shared/<file>`,
// never `src/` -- measured: zero imports of `../../src` anywhere under modules/. So a module that
// needed the vocabulary had no way to reach it, and the practical result was that module error
// paths interpolated raw provider bodies while the host scrubbed. That asymmetry is the whole
// reason the leak this file was added for survived a hardening pass and a green gate.
//
// WHY A RE-EXPORT AND NOT A COPY. A copied helper forks at copy time, and the weakest copy ends up
// guarding the least-watched path -- which is exactly what happened with
// src/providers/openai-image.ts, a file hardened by cf#223 that nothing imported, sitting one
// directory from a live path that was not. The same defect twice in one lineage is enough. There is
// ONE implementation and both sides point at it.
//
// SAFE TO BUNDLE. src/log-scrub.ts imports nothing -- no Env, no binding, no platform type -- so a
// module pulling it in gets three pure functions and no host coupling. Verified before doing it.
//
// WHAT MUST NOT COME BACK. If you are about to add a `const`, a `function` or an `interface` here,
// that is the duplicate this file exists to prevent. Add it to src/log-scrub.ts and let it flow
// through. A guard asserts this file declares nothing
// (tests/modules-log-scrub-reexport.test.ts), for the reason the sibling re-export guards give:
// sync-checking the copy you KEPT protects only the copy you kept, so an absence has to be asserted
// on purpose or nothing notices it decay.
//
// THE EVENTUAL HOME, stated so it is not re-litigated: cp#321 ruled that a contract shared across
// repo boundaries belongs in vivijure-core, and modules/_shared/runpod-route.ts is that pattern. If
// the control plane ever needs this vocabulary too, core is where it goes and this file becomes a
// re-export of core instead of of src/. That is a core release plus a pin bump, deliberately NOT
// bundled into a security fix.
// ------------------------------------------------------------------------------------------------

export * from "../../src/log-scrub";
