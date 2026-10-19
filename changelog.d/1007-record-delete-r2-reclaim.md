### fix(delete): project and render delete now free their R2 objects (cf#1007, cf#779)

`PRIVACY.md` Section 7 promises that the studio's delete actions "remove the
corresponding records and free their stored files". Cast delete has done that
since #298; project and render delete dropped the D1 row and freed nothing, and
because `r2-orphan-reconcile.ts` treats every non-cast key as out-of-scope, the
row was the last thing that named those objects.

Both routes now reclaim before the row goes. Candidates come from the RECORDS,
never from a prefix: the row's key columns, its film and clips job documents
(including takes, which `archiveExistingClipTakes` records nowhere else), its
`shot_records`, its own `renders/<job_id>/` tree, the `renders/logs/<job_id>.txt`
log that nothing in D1 names, and the suffix sidecars of each key that is
actually going. A project delete reclaims all of its renders as one operation
and drops them with it.

Every candidate is gated on not being referenced by a surviving record.
`renders/<project>/...` is a cross-render namespace that `assertProjectKey`
enforces and that take-archiving and keyframe adoption both read, so a prefix
sweep there would destroy a sibling render's only copy of its clips.
`countOtherRowsWithOutputKey` is the gate for `output_key`, which is its first
caller; it is used only for a single-row delete, because in a cascade it counts
the other doomed rows as live.

Ordering: R2 first, the row last, and only on a complete reclaim. An incomplete
reclaim keeps the record and answers 409, so the keys stay findable and a retry
converges. The reverse ordering turns one failed delete into a permanent
invisible leak.

Cast delete also collects `wan_lora_key_high` / `wan_lora_key_low`, and
`voice_ref_key` when it is the member's own `cast/<id>/` object. The generated
sample shape is ONE key shared by every cast member and is left behind
deliberately; see cf#1008. The remaining orphan backlog is cf#1009.
