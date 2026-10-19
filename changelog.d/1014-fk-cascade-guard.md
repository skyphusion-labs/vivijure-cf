### test(migrations): guard against an ON DELETE CASCADE that would undo cf#1007

Conrad ruled on 2026-10-19 that deleting a project deletes its renders. The
schema does not say so: `renders.project_id` and `renders.parent_id` are
comments (`-- logical FK`), and this schema declares no foreign keys at all.
So "make the schema honest about the ruling" is a plausible future cleanup
whose obvious spelling is `ON DELETE CASCADE`, and that would silently undo
cf#1007.

A cascade on either column deletes the rows that NAME a render's R2 keys
inside the same statement that deletes the parent, so the reclaim in
`hDeleteProject` / `hDeleteRender` can never run first. Every object is
orphaned with nothing left to find it by, the orphan sweep is cast-only and
will not collect it, and the DELETE succeeds with D1 looking perfectly
consistent. It fails in the reassuring direction.

`ON DELETE RESTRICT` was considered and rejected as the primary control. It
orders the two D1 deletes against each other and says nothing about R2:
deleting the render rows and then the project row satisfies it and leaks
every object. It would also read as though the class were closed, which is
worse than the prose it replaces.

Test only. No FK is declared, no table is rebuilt, no handler changes.

The detector strips SQL comments with quote tracking rather than by line,
because a migration DOCUMENTING this prohibition is the likeliest thing to
land in that directory, and a `--` inside a string literal would otherwise
hide a real cascade. A second pass blanks string literals for the premise
check, since the demo seed contains the English words "Training references".
Both FK spellings are covered, both guarded columns, subdirectories included,
and the scan asserts it read the tree so a wrong path cannot pass as a clean
schema.
