# cf#480 -- the mutation proof for the on-iron finish door

`tests/finish-door-cf480.test.ts` is a green suite, and a green suite is not evidence until someone
has watched it go red. This file records what was mutated, which assertion caught it, and what the
defect would have cost in production, so a reviewer can check the guards without re-deriving them
and a later editor can see which line is load-bearing before deleting it.

**Harness:** `scripts/cf480-mutation-proof.py`, runnable. It refuses to start on a dirty tree (it
restores with `git checkout --`, which destroys uncommitted work), refuses to start on a red
baseline (a mutation's red would be indistinguishable from a pre-existing one), asserts each
mutation's anchor matches **exactly once** before applying it (a `str.replace` that matches nothing
is silent, and a mutation that never landed produces a GREEN run reading exactly like a working
guard), and checks for the **named** victim rather than for red -- a run can go red because
something unrelated broke or because the harness itself died, and both look like a passing control.

**Result, 2026-08-07: 6 of 6 proven, each red for its named reason, tree verified clean after each.**

| # | Mutation | Named victim | What it would have cost |
|---|---|---|---|
| M1 | `poll` chooses the transport from CURRENT config instead of from the token | `a RunPod-minted token polls RUNPOD even though a door is bound` | The door 404s a job id it never had, `runpodJobGone` reads that as a GC'd job, and past the grace window the shot FAILS. Finished work destroyed while every component behaves correctly. |
| M2 | a door failure falls through to RunPod | `a door FAILURE degrades honestly and STILL does not touch RunPod` | Silently re-rents the GPU this change exists to stop renting, at the moment nobody is watching, with every signal green. The saving decays to zero unobserved. |
| M3 | the poll token stops recording which transport minted the job | `submit -> poll round trip keeps the label` | Affinity is lost at the source rather than at the poll: every door job becomes a RunPod-labelled token, which is M1's failure arriving one step earlier. |
| M4 | the `Transport` indirection drops the caller's headers on the RunPod arm | `finish-upscale still builds RunPod's own URL, method and headers` | A dropped `content-type` on `/run` in the path this PR did not mean to touch. Regression in the UNTOUCHED arm, which is the one nobody re-checks. |
| M5 | a bound-but-tokenless door reads as UNBOUND | `bound WITHOUT a token is propagation` + `bound but tokenless degrades as PROPAGATION` | A door whose secret has not propagated yet silently resumes renting RunPod, and reports itself healthy while doing it. The failure this PR's whole bound-ness rule exists to make impossible. |
| M6 | `/ready` emits the `door` key unconditionally | `UNBOUND: no \`door\` key at all` + `reports ok with both credentials visible` (in `tests/module-ready.test.ts`) | Edits the `/ready` shape for five modules that can never bind a door, breaking the module-agnostic contract the control plane's prober is built on. |

## What this proof does NOT cover, stated so a reader does not price it as more than it is

* **It is all stubs.** A stub encodes the author's own assumption about the wire, so this proves the
  DECISION PATH and never the shipped artifact. The door's contract was read out of
  `vivijure-upscale`'s `runpod_http_serve.py` at `origin/main` rather than guessed, but nothing here
  has spoken to a real door. **Live verification against a bound binding is part of done and has not
  happened**, because the connectivity-directory service does not exist yet (see the PR body).
* **The un-stubbable seam is the binding itself.** The tests hand the module a `{ fetch }` object,
  which is structurally what wrangler hands a Worker, so the routing, the header construction and
  the affinity derivation are all shipped code. What is stubbed is the transport's far end.
* **M2 mutates the caller, not the wire.** It proves the module does not fall through to RunPod on a
  door failure. It does not prove Cloudflare cannot route a VPC binding somewhere unexpected.
