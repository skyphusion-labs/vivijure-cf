### Fixed

- **Reconcile counters no longer conflate "we saw it finish" with "we stopped waiting" (cf#523).**
  `reconcileOpenRunpodJobs` incremented `closed` on the same row as `unknown`, so scoring a run on
  `closed` counted every job we gave up on as a job we observed finishing -- silently, and in the
  flattering direction. The single `closed` field is REMOVED rather than renamed, because a name
  nobody can reach cannot be misread. The pass now returns `examined`, `resolved`, `unknown`,
  `stillOpen` and `skipped`, and the suite asserts the four buckets sum to `examined` so no row is
  uncounted.
- **`isResolvedRunpodOutcome` / `RESOLVED_RUNPOD_OUTCOMES` are exported for the database path.** A
  terminal write fills `terminal_at` for every outcome except `submitted`, so
  `terminal_at IS NOT NULL` is NOT a completion predicate: it is true of a job we watched finish and
  equally true of one we abandoned. Any completion or capacity metric keys on `outcome` instead, and
  the classifier is a `Record` over the outcome union so a new outcome fails typecheck until someone
  decides which side it falls on.
