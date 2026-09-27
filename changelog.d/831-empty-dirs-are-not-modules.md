### fix(ci): an empty directory left by a merge is not a module (vivijure#831)

`check-capability-matrix.mjs` counted a module by its DIRECTORY. **Git does not track empty
directories**, so when a module's tracked files are removed by a merge, `git pull` leaves the parent
behind, and the tree is then wrong in a way **no git instrument reports**: `git status` clean,
`git ls-files` nothing, `git check-ignore` not-ignored, while `readdirSync` counts a module that does
not exist.

**So the gate fails LOCALLY while CI is green on the same commit**, because CI is a fresh checkout and
never sees them. A developer cannot debug that with git: every git command agrees the tree is correct.

Measured by mackaye on 2026-09-27: `finish-lipsync` and `speech-upscale` survived as empty directories
after their retirement merges (cf#785, cf#787) and produced exactly that unexplainable local red,
costing about twenty minutes. Reproduced deliberately here, both directions:

```
mkdir -p modules/ghost-empty-dir && npm run check:matrix
  BEFORE: 35 modules on disk, 34 named in 12 matrix rows
          FAIL -- 1 module(s) exist but are NOT in the matrix: ghost-empty-dir
  AFTER:  34 modules on disk, 34 named in 12 matrix rows   OK
```

A directory is a module when it holds a module ENTRY FILE. `MODULE_ENTRY_FILES` is now shared between
the population (`realModules`) and `declaredHookCount`, **which already read those same two paths** --
so the two cannot drift into describing different sets, which was a latent second bug in the same
file. `isModuleDirectory(name, exists)` takes its existence check as a parameter, so both answers are
driven in a test without touching disk.

Four cases added to `tests/capability-matrix-gate-830.test.ts`, and the control was watched red:
making the predicate `return true` (every directory counts again) fails **exactly one** case, the one
named "CONTROL: does NOT count a directory with no entry file -- the whole defect". It discriminates
rather than going red alongside everything else.

**The class, since this is not one gate's problem:** any check deriving a population from `readdirSync`
over a directory of directories has it, and the failure is local-only, invisible in CI, and
undebuggable with the tool a developer reaches for first. Other `readdirSync` populations in this repo
were NOT swept; several read `modules/*/src/index.ts` directly and are immune by construction. Naming
which are which is worth a deliberate pass rather than an assumption, and vivijure#831 says so.

Also in this change, from the same review: `scripts/matrix-transition.txt` now states **how many PRs
each order costs**. The transition file lives in this repo, so the line can only be deleted by a
vivijure-cf PR. If the hub edit lands SECOND, the deletion cannot ride with it and the sequence is
THREE PRs, not two. Neither order is wrong and both stay green; hub-first is simply one PR shorter.
That was not obvious from the previous wording and it should not have to be rediscovered.
