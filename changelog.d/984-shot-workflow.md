### feat(shot): a shot is a Workflow over D1 and R2 (cf#984)

The film job document in R2 stays the orchestrator's copy. `shot_records` is the
per-shot step record: still key, wav key, clip key, and which step is running.
A failed step retries that step. The clip call is a presigned URL. The studio
worker does not buffer the MP4. A tenant worker and a dispatch module do not
receive the R2 credential. Vendor modules that already have a Workflow are not
wrapped again.
