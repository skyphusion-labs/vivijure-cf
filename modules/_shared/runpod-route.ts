// POINTER, NOT AN IMPLEMENTATION. The RunPod route contract lives in vivijure-core (cp#321).
//
// ------------------------------------------------------------------------------------------------
// WHY THIS FILE IS ONE LINE. Every symbol that used to be declared here now lives at
// `@skyphusion-labs/vivijure-core/runpod-route`, and the control plane's proxy is the other end of
// the same contract. Two copies of one cross-repo contract is cf#403: a suite that constructs BOTH
// halves from its own copy cannot detect a rename on the other side, so the halves move together in
// the test and independently in production. cp#321 ruled the fix explicitly -- move it into core,
// have both sides import it, do NOT write a second implementation.
//
// WHY A RE-EXPORT RATHER THAN DELETING THE FILE. Measured on this tree, not assumed: 15 module
// workers plus 4 test files import this exact path. A re-export is one file changed; deleting it is
// 19. The import specifier every module already writes keeps working unchanged.
//
// (An earlier handoff of mine said "26 modules import this path". That number was wrong and was
// carried from a different measurement -- modules referencing the RunPod HOST -- rather than
// measured here. It is 15 modules of 28, plus 4 tests and 3 docs, 22 files referencing in total.)
//
// WHAT MUST NOT COME BACK. If you are about to add a `const`, a `function` or an `interface` to this
// file, that is the duplicate this change removed, reappearing in the exact file that was fixed.
// Add it to core and let it flow through here. A guard asserts this file declares nothing
// (tests/runpod-route-reexport-cp321.test.ts), because sync-checking the copy you KEPT protects
// only the copy you kept -- an absence has to be asserted on purpose or nothing notices it decay.
//
// THE HALF NOBODY CAN CLOSE FROM THIS REPO, stated so it is not mistaken for coverage: core is not a
// dependency of vivijure-control-plane and vice versa, so the plane's mount prefix
// (`PROXY_UPSTREAM_PREFIX`) and its refusal header are checked in core BY STRING. A rename on the
// PLANE side is invisible to every test in cf and in core. The cf <-> core half is now closed by
// construction, because this file has nothing of its own to drift. That is one half, not both.
// ------------------------------------------------------------------------------------------------

export * from "@skyphusion-labs/vivijure-core/runpod-route";
