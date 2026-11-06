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
| `renders/clips-<uuid>/...` | a `clip_job_id` a live film doc names | keep if named, otherwise out of scope (a standalone `POST /api/clips` job has no row; cf#1309) |
| `renders/logs/<job-id>.txt` | the same job id | keep if live, otherwise orphan |
| a job-shaped segment equal to a live project name, raw or sanitised | ambiguous | out of scope |
| project-keyed trees, `renders/cast/`, and everything outside `renders/` | not provable | out of scope |

Out of scope by ruling: project-keyed trees (two sanitisers disagree on the segment, and names are
mutable), standalone clip jobs, and record-free namespaces (`keyframe-stage/`, module state docs,
unreferenced `bundles/`). There is no age rule without a later ruling.

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
