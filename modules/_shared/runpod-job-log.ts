// POINTER, NOT AN IMPLEMENTATION. The RunPod job log lives in vivijure-core (cf#475).
//
// ------------------------------------------------------------------------------------------------
// WHY THIS FILE IS ONE LINE. Every symbol that used to be declared here now lives at
// `@skyphusion-labs/vivijure-core/runpod-job-log`. This is the same move cp#321 made for
// `runpod-route.ts` and for the same reason, but the trigger here was a measured wrong number rather
// than a rename risk.
//
// THE TRIGGER. Cast LoRA training submits to RunPod from CORE, not from a module worker. Core sits
// UPSTREAM of this file in the dependency graph, so it could not import the recorder no matter how
// the call site was written, and it recorded nothing. Measured on the money: the vivijure-wan-train
// endpoint billed 14.5% of GPU spend on 2026-08-01 and 21.9% on 2026-08-02 with ZERO rows in
// runpod_job_log on either day (cf#475). Not mis-attributed. Absent, and absent in the flattering
// direction, because every row that IS in the table is correct.
//
// The alternative was a second recorder inside core for one table. There were already TWO copies of
// this file in the estate before this change -- here, and vivijure-local's src/runpod-job-log.ts --
// and they had ALREADY DRIFTED, measured 2026-08-15: local still carries DETAIL_MAX = 160, the exact
// truncation cf#320 raised to 480 here, lacks the `unknown` outcome cf#298 added here, and has no
// timing columns at all. Two copies of one rule is not a hypothetical failure mode on this file; it
// is the state it was already in. A third copy was not the fix.
//
// WHY A RE-EXPORT RATHER THAN DELETING THE FILE. Measured on this tree, not assumed: 15 module
// workers plus 3 test files import this exact path, 97 call sites in total. A re-export is one file
// changed; rewriting every import is 18. The specifier every module already writes keeps working.
//
// WHAT MUST NOT COME BACK. If you are about to add a `const`, a `function`, an `interface` or a
// `type` to this file, that is the duplicate this change removed, reappearing in the exact file that
// was fixed. Add it to core and let it flow through here. tests/runpod-job-log-reexport-cf475.test.ts
// asserts this file declares nothing, because sync-checking the copy you KEPT protects only the copy
// you kept -- an absence has to be asserted on purpose or nothing notices it decay.
//
// ONE TYPE CHANGE, AND IT IS DELIBERATE. Core types the database handle as the platform `Database`
// rather than `D1Database`. The structural surface is the same (prepare / bind / run / all / first),
// so every existing call site passing `env.TELEMETRY_DB` typechecks unchanged; what it buys is that
// vivijure-local can eventually retire its own copy against THIS code rather than a same-looking one.
//
// THE HALF THIS DOES NOT CLOSE, stated so it is not mistaken for coverage: vivijure-local still runs
// its own copy today, because its table has no execution_ms / delay_ms columns and core's upsert
// writes nine. Collapsing local onto core needs that migration first and is filed separately. Until
// it lands, the cf <-> core half is closed by construction and the local half is not.
// ------------------------------------------------------------------------------------------------

export * from "@skyphusion-labs/vivijure-core/runpod-job-log";
