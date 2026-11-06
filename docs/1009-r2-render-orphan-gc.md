# cf#1009 -- R2 render-orphan GC: the provable part

The second half of the #779 code ruling, built to the lead's 2026-11-06 ruling on #1009. The core is
`src/r2-render-orphan-reconcile.ts`, which is pure and tested in `tests/r2-render-orphan-1009.test.ts`
against real SQLite and an in-memory bucket. The IO is `scripts/r2-render-orphan-gc.ts`. The cast
reconciler (`docs/309-r2-orphan-gc.md`) is unchanged.

## Safety model

The same rule as the cast reconciler: a key is an orphan only when no live owner is found, and
anything whose owner cannot be proven from records is out of scope, never deleted.

| key | owner | verdict |
|---|---|---|
| named by a live renders row, shot record, or a live film, scatter or clip job doc | that record | keep, in any tree |
| younger than the grace window (48 h), or with no readable mtime | maybe in flight | keep |
| `renders/film-<uuid>/...`, `renders/scatter-<uuid>/...` | `renders.job_id`, `shot_records.film_id`, or a shard a live scatter doc names | keep if live, otherwise orphan |
| `renders/clips-<uuid>/...` | a `clip_job_id` a live film doc names, or a live `renders.job_id` (a standalone `POST /api/render/clips` job, cf#1309) | keep if owned; otherwise orphan if the tree holds `owner.json`, out of scope if it does not |
| `renders/logs/<job-id>.txt` | the same job id | keep if live, otherwise orphan |
| a job-shaped segment equal to a live project name, raw or sanitised | ambiguous | out of scope |
| project-keyed trees, `renders/cast/`, and everything outside `renders/` | not provable | out of scope |

Out of scope by ruling: project-keyed trees (two sanitisers disagree on the segment, and names are
mutable), clip job trees with no owner marker, and record-free namespaces (`keyframe-stage/`, module
state docs, unreferenced `bundles/`). There is no age rule without a later ruling.

### Standalone clip jobs (cf#1309)

Since cf#1309, `POST /api/render/clips` writes, in this order: the job doc, then the owner marker
`renders/<clips-id>/owner.json`, then a `renders` row whose `job_id` is the clip job id. The row owns
the tree. The marker proves the tree was born with a row, so a marked tree whose row is gone is an
orphan once it is out of the grace window. A tree with no marker is either a film's clip job (named by
its film doc while the film lives) or a standalone job from before cf#1309. Nothing proves either one
dead, so both stay out of scope, at any age.

The marker is read from the listing. It is deleted LAST in its tree, and `--apply` keeps it if any
other key in that tree failed to delete, so the failed key still reads as an orphan and the re-list
check reports it (exit 1). Without the hold the failed key would read as legacy, out of scope, and the
check would print "verified" with it still present: measured on the 2026-11-06 smoke below.

A crash between the marker and the row leaves a marked tree with no row. The next poll of the job
inserts the row. A job nobody polls again becomes an orphan after the grace window, which is the same
outcome the film door has when its best effort row insert fails.

## How to run

1. Snapshot the owners immediately before the run. Run each query the core exports with
   `wrangler d1 execute <db> --remote --json --command "<sql>"`: `RENDER_OWNER_SQL`,
   `SHOT_OWNER_SQL` and `PROJECT_NAME_SQL`. Write the rows as
   `{ "renderRows": [...], "shotRows": [...], "projectNames": [...] }`. Keep the file with the report.
2. Dry run (the default; lists every orphan with its reason, deletes nothing):
   `node scripts/r2-render-orphan-gc.ts --owners <snapshot.json>`
3. Apply, only after a human has read the dry run:
   `node scripts/r2-render-orphan-gc.ts --owners <snapshot.json> --apply`

Flags: `--grace-hours <n>` (default 48) and `--max-objects <n>` (default 200000; a larger listing is
refused before anything is judged). The run aborts, deleting nothing, if a live job doc is listed but
cannot be read. R2 is an rclone remote (`R2_REMOTE`, `R2_BUCKET`; default `r2:vivijure`).

Smoke-tested on 2026-11-06 against an rclone local remote:
- the dry run deleted nothing;
- `--max-objects 3` refused a 7-object listing with exit 2 and deleted nothing;
- `--apply` deleted the 3 orphans (a dead film tree and its log), and the re-list check reported 0
  orphans remaining;
- the live tree, a tree inside the grace window, the project tree and the bundle stayed.

Smoke-tested for cf#1309 on 2026-11-06 against an rclone local remote, with a row-owned clip job, an
unmarked clip job, a marked clip job with no row, and a marked clip job with one file that could not be
deleted (a read-only directory):
- the row-owned tree and the unmarked tree stayed;
- the marked tree with no row and its log were deleted, marker last;
- in the tree with the stuck file, the marker was kept, the re-list check listed both, and the run
  exited 1;
- CONTROL: with the marker hold disabled, the same run deleted the marker, printed "verified: orphan
  set is empty" and exited 0 with the stuck file still present. The hold is what makes the check honest.

## Dry-run report from files (no R2 access in the tool)

`scripts/r2-render-orphan-report.ts` applies the same rules, but it reads three local files and writes a
report. It holds no delete call, no network call and no subprocess, and
`tests/r2-render-orphan-report-1009.test.ts` fails if one appears in it or in anything it imports. The
operator produces the inputs read-only. The sweep's rule is the #779 code ruling ("delete R2 artifacts on
project/render delete, gated by `countOtherRowsWithOutputKey`, plus a real orphan sweep"), as narrowed in
#1009: a key is an orphan only when no live owner is found, and anything unrecognised is out of scope.

The inputs go in one directory, for example `/Users/joan/scratch/sweep1106/live/`:

```sh
OUT=/Users/joan/scratch/sweep1106/live; mkdir -p "$OUT/docs"; cd <vivijure-cf checkout>
```

**1. Owner snapshot.** Three SELECTs, the ones the core exports (`RENDER_OWNER_SQL`, `SHOT_OWNER_SQL`,
`PROJECT_NAME_SQL`), each read-only:

```sh
for q in \
  "SELECT id, job_id, project, bundle_key, output_key, keyframes_json, output_json FROM renders" \
  "SELECT film_id, still_key, wav_key, clip_key FROM shot_records" \
  "SELECT name FROM storyboard_projects"; do
  npx wrangler d1 execute vivijure-studio --remote --json --command "$q"
done > "$OUT/d1.json"
jq -s '{renderRows: .[0][0].results, shotRows: .[1][0].results, projectNames: [.[2][0].results[].name]}' \
  "$OUT/d1.json" > "$OUT/owners.json"
```

**2. Listing** of `renders/`, as JSON lines of key, size and upload time. Take it right after the snapshot,
because a row created after the snapshot reads as dead, and only the grace window protects it. Either
S3 ListObjectsV2 (the CLI paginates):

```sh
aws s3api list-objects-v2 --endpoint-url "https://<account-id>.r2.cloudflarestorage.com" \
  --bucket vivijure --prefix renders/ --output json \
  | jq -c '.Contents[] | {key: .Key, size: .Size, uploaded: .LastModified}' > "$OUT/listing.jsonl"
```

or rclone, with a read-only R2 remote:

```sh
rclone lsjson --files-only --recursive r2:vivijure/renders/ \
  | jq -c '.[] | {key: ("renders/" + .Path), size: .Size, uploaded: .ModTime}' > "$OUT/listing.jsonl"
```

**3. Live job docs.** The tool names the ones it needs. A film doc names its clip job, so this takes two
rounds, and exit 3 means "fetch these, then run again":

```sh
node scripts/r2-render-orphan-report.ts --listing "$OUT/listing.jsonl" --owners "$OUT/owners.json" \
  --docs "$OUT/docs" --needed-docs > "$OUT/needed.txt"
while read -r k; do
  mkdir -p "$OUT/docs/$(dirname "$k")"
  npx wrangler r2 object get "vivijure/$k" --remote --file "$OUT/docs/$k"
done < "$OUT/needed.txt"
# repeat the two commands above until --needed-docs exits 0
```

**4. The report:**

```sh
node scripts/r2-render-orphan-report.ts --listing "$OUT/listing.jsonl" --owners "$OUT/owners.json" \
  --docs "$OUT/docs" --out "$OUT/report.json" > "$OUT/report.md"
```

`report.md` is ready to post. It gives the counts and bytes per rule, and the first 10 keys of each rule
in key order. `report.json` holds the same, plus every would-delete object with its rule and its reason.

| rule | decision |
| --- | --- |
| `job-dead`, `log-dead`, `clips-marked-dead` | would delete |
| `named`, `grace`, `no-mtime`, `job-live`, `log-live`, `clips-live` | keep |
| `not-renders`, `not-job-tree`, `project-name`, `clips-unmarked` | out of scope |

## The GC's own dry run reports per rule too (cf#1009, sweep1106)

`scripts/r2-render-orphan-gc.ts`, run without `--apply`, prints:
- every would-delete object, as `DELETE <key> (<size> B) [<rule>: <reason>]`
- then a per-rule block: decision, rule, count, bytes, and the first 10 keys in key order, with the rules
  from the table above

It calls rclone only to list (`lsjson`) and to read live job docs (`cat`), so a read-only R2 key is
enough. `tests/r2-render-orphan-gc-dry-run-1009.test.ts` runs it against a fake rclone that refuses
anything else. With the owner snapshot from step 1 above:

```sh
R2_REMOTE=r2 R2_BUCKET=vivijure node scripts/r2-render-orphan-gc.ts --owners "$OUT/owners.json" > "$OUT/report.txt"
```
