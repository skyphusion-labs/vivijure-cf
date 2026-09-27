### fix(ci)!: the capability-matrix gate tolerates ONE declared transition, in both directions (vivijure#830)

`scripts/check-capability-matrix.mjs` enforces agreement in both directions between `modules/` here and
`docs/CAPABILITIES.md` in the hub, **read from the hub's `main`**. Those live in two repos, so the two
edits cannot be atomic and **every order goes red mid-flight**: retiring hub-first leaves a module with
no row, cf-first leaves a row with no module, and adding does the same in mirror image.

**The part that made it urgent is not the inconvenience, it is where the red lands.** Because the gate
reads the hub at `main`, it fails on PRs whose diff has nothing to do with either edit. A check that
freezes unrelated merges over a condition outside their change is the shape this estate refuses
everywhere else. My own header in that script said "the remedy is a one-row edit", which was wrong: the
row is in another repo.

**The generalisable rule, recorded because it is not specific to this gate:** a bidirectional
consistency gate across two repos cannot be satisfied atomically, so it must tolerate one declared
transitional state or it forbids the transition it exists to keep honest.

`scripts/matrix-transition.txt` is that declaration, one line of `<module> <retiring|adding> <issue>`.
It is deliberately hard to abuse, and each of these is a test:

- **every entry is printed** with which side it currently exists on;
- **an entry must exist on at least one side**, so it cannot be speculative;
- **a COMPLETED transition is a hard FAIL, not a no-op.** `retiring` completes when module and row are
  both gone; `adding` when both are present. **An exemption that cannot be left behind is not a hiding
  place**, and that is the only property standing between this file and one;
- **a `retiring` module whose row is already gone must be named in the hub's `## Retired` section.**
  Erasing a capability from the matrix outright is the exact failure this gate exists to catch, so a
  transition entry must not become the quiet way to do it;
- **a malformed line FAILS the run.** A lenient parser would drop an exemption, which silently
  reintroduces the deadlock while looking like the gate working.

**Symmetric on purpose: this unblocks a module ADDITION exactly as it unblocks a retirement.** The
deadlock hit `kling`'s retirement first, and it would have hit the next new door the same way.

**The gate had ZERO tests while blocking two lanes**, and it exported `parseMatrixModules` "so a test
can import it" with no such test ever existing. Its whole judgement is now the pure `evaluateMatrix`,
with the I/O left in `main()`, so the verdicts can be driven directly instead of only against whatever
state two live repos happen to be in. `scripts/check-capability-matrix.d.mts` types it for the test
rather than casting to `any`.

**Every tolerance has a paired control, because a widening is only safe if the un-widened cases still
fail.** 15 cases in `tests/capability-matrix-gate-830.test.ts`, including: a module with no row still
fails; a row naming a module that does not exist still fails **and is not excused by the Retired
section alone**; over-crediting a module in more rows than it declares hooks still fails; and a
transition exempts **only its own name**, never the rest of the disagreement.

Both mutations were watched red rather than assumed. Making the exemption blanket (exempt every name
once any transition is declared) fails 2 of 15, including "exempts ONLY its own name". Disabling the
completed-transition checks fails exactly the 2 staleness cases. The controls discriminate instead of
going red together.

Gate: `npm run typecheck` exit 0; `npm test` exit 0 (3785 passed, 3 skipped); `conformance`,
`check:catalog`, `check:matrix` all exit 0. `check:matrix` prints
`TRANSITION kling (retiring, cf#921) -- in modules/, in the matrix; exempted`.

**Ordering, which is the whole point:** this lands FIRST. With it on `main`, the hub row edit
(`skyphusion-labs/vivijure` #829) and the `modules/kling` retirement (cf#921) are each independently
green in either order, and the `kling` line gets deleted in the same PR as the second of the two.
