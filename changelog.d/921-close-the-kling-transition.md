### chore(ci): delete the spent kling transition line, unbreaking main (cf#921, vivijure#830)

Both halves of the kling retirement are now on `main`: the hub row moved to Retired
(`skyphusion-labs/vivijure`#829) and `modules/kling` is gone (cf#921, #958). **That completes the
declared transition, and a completed transition is a hard FAIL by design**, so `main` went red on
`check:matrix` the moment the second half landed:

```
check-capability-matrix: 33 modules on disk, 33 named in 12 matrix rows, 0 in declared transition
FAIL -- scripts/matrix-transition.txt still lists "kling" as retiring (cf#921) but the retirement
        is COMPLETE (NOT in modules/, NOT in the matrix). Delete the line; a spent exemption is a
        standing hole.
```

**This is the mechanism working, not a defect.** The whole argument for letting a gate tolerate a
transitional state was that the tolerance must not be able to outlive the transition, and the only
thing that makes that true is failing loudly when it does. It did, in CI, on the real retirement,
naming the file and the line. The file is now back to its steady state of no entries.

**It is also the third PR of the sequence this same PR documents**, and the documentation was written
before the sequence ran: the transition file lives in this repo, so when the hub edit lands SECOND the
line cannot be deleted alongside it. cf-first costs three PRs. That prediction is now observed rather
than reasoned about.

Gate: `npm run typecheck` exit 0; `npm test` exit 0 (3776 passed, 3 skipped); `conformance`,
`check:catalog`, `check:matrix` all exit 0, with `check:matrix` reading
`33 modules on disk, 33 named in 12 matrix rows, 0 in declared transition ... OK`.
