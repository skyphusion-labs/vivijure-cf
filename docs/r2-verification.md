# R2 verification: listing is authority (cf#300)

## The hazard

Cloudflare's account API **object-GET** can serve a **stale body** for an R2 key that has been
overwritten, while the **same API's listing** route reports the new object (etag + size). Measured
on production: disagreement persisted at +1, +4 and +36 minutes after overwrite (including with
`Cache-Control: no-cache`). A never-overwritten control key matched GET and listing exactly.

Routes:

```
GET /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}          <- may serve the PREVIOUS body
GET /accounts/{account_id}/r2/buckets/{bucket}/objects?prefix={key}   <- reports the CURRENT object
```

The A/B pattern "render, read, change one knob, re-render to the **same key**, read again, compare"
is therefore silently broken: the second body read can return the first render, so the result is
always "nothing changed" -- the most dangerous false negative for identity / injection checks.

## HARD RULE

**Never decide "this overwrite changed (or did not change) bytes" from the CF API object-GET alone.**

Do one of these instead:

1. **Listing authority:** compare `etag` and `size` from the LISTING route, matching the **exact
   key**. A prefix query also returns sidecars (`<key>.hash`, `<key>.prov`, frames meta); `result[0]`
   is not necessarily your object -- filter by exact key.
2. **Distinct keys:** write each variant to a different key and compare bodies across keys (GET is
   fine when the object was never overwritten).
3. **Body-level A/B via S3 API:** use real R2 credentials (SigV4), read the object, and **verify the
   response `ETag` against the listing** before trusting the bytes.

## Where this is recorded

- `harness/cf278/README.md` -- operational HARD RULE for phase-1 evidence
- This file -- constellation rule for any runbook that says "fetch the artifact and check it changed"
- Issue skyphusion-labs/vivijure-cf#300

## Runbook wording

Anywhere a procedure says "fetch the artifact and check it changed":

- **Identity / "did it change?":** listing etag+size (exact key), or distinct keys.
- **Eyeballing content:** body GET is fine for display; do not use it as the sole proof of a same-key
  overwrite.

The general form: **a read that can serve a previous epoch is indistinguishable from a read that
says "nothing changed"**, and the reassuring interpretation is the one that gets believed.
