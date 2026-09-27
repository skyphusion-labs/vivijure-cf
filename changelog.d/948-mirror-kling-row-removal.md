### chore(mirror): follow the plane dropping the `kling` catalog row (cp#538)

The control plane removed `kling` from `TENANT_MODULE_CATALOG` because its RunPod slug
`kling-v2-1-i2v-pro` returns 404 endpoint-not-found -- it answered 401-exists on 2026-08-05, so it
was retired upstream between those dates (cf#921, and the scheduled liveness census cf#941 is what
keeps reporting it). A catalogued door with nothing behind it fails 100% of submits, which is worse
than absent, and `wrangler.toml.example:387` had already said Kling 2.1 is NOT bound on hosted while
the catalog shipped it to hosted tenants anyway.

This repo's mirror, its provenance stanza and every population-4 denominator follow: population 4
goes 17 to 16, `16 of 34` replaces `17 of 34` in both places the prose states it, the
not-provisioned bullet goes 17 names to 18, and `kling` joins the published-not-catalogued set as
its fourth distinct reason -- the only one there that is not waiting on something we could build.

**The BUNDLE keeps publishing.** `kling` stays in `tenant-release-modules.txt`: whether
`modules/kling` itself is retired is cf#921, in this repo, and a published bundle with no catalog
row uploads to nobody. The plane's catalog and this repo's module tree are allowed to disagree in
that direction, which is the whole point of the gap.

**This PR is RED until cp#539 merges, by design.** `check-tenant-module-catalog.mjs` fetches the
plane's `main` and asserts set-equality, so a mirror corrected before the authority moves is a
mirror that disagrees with it. The check currently reports, precisely: `in the plane, NOT in the
mirror: kling`. It inverts to green the moment the plane's PR lands, and that ordering cannot be
reversed without defeating the control.
