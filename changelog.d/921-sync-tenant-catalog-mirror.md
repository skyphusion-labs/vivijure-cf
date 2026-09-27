### fix(catalog): sync the tenant-catalog mirror after the plane dropped kling (cf#921, cp#538)

`main` was red on `check:catalog`, and not because of anything in this repo: the control plane
removed the `kling` row (plane #539, `249c085d`, on cf#921), so the live authority went from 17
entries to 16 while this repo's mirror still carried 17. That check fetches the authority on every CI
run and fails closed, which is exactly what it is for; this is the mirror catching up.

- `scripts/tenant-module-catalog.txt`: `kling` removed, count 17 -> 16, provenance header updated to
  name the plane commit it was read at rather than just a date.
- `docs/module-readiness-coverage.md`: population 4 is **16 of 34**, the per-module table's
  provisioned column for `kling` is now `no` (its PUBLISHED column stays `yes`, which is the whole
  asymmetry), and the not-provisioned bullet is 18 names instead of 17.

**Population 4 has SHRUNK for the first time, and the direction carries information.** Every previous
move was the plane catching up to published bundles. This one is a row being taken away because the
door cannot render: `kling-v2-1-i2v-pro` returns 404, so every submit failed. A catalogued door that
cannot render is worse than an absent one.

**So populations 3 and 4 are now SEVEN apart, not six, and the seventh member has a cause the other
six do not share.** The other six are published AHEAD of a row that waits on a capability
(`image-generate` on a credential, `dialogue-gen` on a Workflows binding the plane cannot emit,
the four VPC-bound finishing modules on a binding `uploadTenantModules` does not write). `kling` is
published BEHIND a row that was removed, and it resolves in the opposite direction: retiring
`modules/kling`, never adding the row back. **Membership in that set no longer implies "waiting to be
enabled", and both the doc and the test now say so** rather than leaving the next reader to infer the
friendlier meaning.

The `publishedNotProvisioned` assertion keeps its set-difference shape (cp#314: a hand-listed loop
re-encodes the stale list it was fixed for) and gains `kling`. `kling` is deliberately dropped from
the loop that asserts published-implies-catalogued, because it is now the documented exception, and it
is pinned in BOTH directions instead (`publishedToTenants()` contains it, `CATALOG` does not) so the
exception cannot quietly drift into a third state.

**Not in this change:** retiring `modules/kling` itself. That is cf#921's own PR and it is ordered
behind a hub edit, because `scripts/check-capability-matrix.mjs` gates `modules/` against the hub's
`docs/CAPABILITIES.md` in both directions. This commit deliberately does the part with no cross-repo
dependency, so `main` goes green now instead of waiting on that sequencing.

Gate: `npm run typecheck` exit 0; `npm test` exit 0 (3763 passed, 3 skipped); `conformance`,
`guard:resolve`, `check:catalog`, `check:matrix` all exit 0. `check:catalog` prints
`authority: 16 entries ... mirror: 16 entries ... OK`.
