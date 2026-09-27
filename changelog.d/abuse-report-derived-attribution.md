### fix(abuse-report): attribute reported keys by derived ownership, and record unbound reports honestly

The report door now derives a reported key's owning project instead of assuming one, and says so in
the hold note when it cannot. `resolveKeyBinding` returns one of three outcomes per key:

- **bound** -- ownership derived and it matches the reported project. Accepted.
- **foreign** -- ownership derived and it belongs to a DIFFERENT project. **Refused.**
- **unbound** -- ownership is not derivable. **Accepted**, and recorded as unbound.

**Unbound is accepted rather than refused, deliberately.** `cast/`, `uploads/`, `character-refs/`
and `cast-gen/` are where caller-supplied imagery lands, so they are the most likely home of
genuinely offending content. A door that refused what it could not attribute would make that
content unreportable, which trades a griefing bound for a takedown path that must not be narrowed.
The door stays open; what it no longer does is claim an attribution it does not have.

**Derivability is measured against the schema, not assumed.** `renders` carries `project` alongside
`bundle_key` and `output_key`, so three key spaces resolve by exact match: `renders/` from the slug
in the key itself, `bundles/` and `out/` by lookup. `cast_members` has no `project_id` and is
globally slug-unique (`migrations/0001_init.sql`), so everything cast-shaped is deploy-wide by
construction and genuinely has nothing to bind to. Nothing resolves by scanning a JSON column: a
`LIKE` over `output_json` would be a guess wearing a lookup's clothes, and a wrong attribution here
refuses a legitimate report.

**The hold note is the record somebody may act on under a reporting duty**, so it no longer lets
`project` read as a verified attribution. It now carries `project_is` (naming it as the reporter's
claim), a per-key `bindings[]` with a closed-set `basis` token, and an explicit `attribution` field
(`all-keys-bound` / `partially-bound` / `no-keys-bound`) alongside `bound_count` and
`unbound_count`. `attribution` is a field rather than something a reader derives, because "every key
attributed" and "no key attributed" would otherwise look identical to someone who did not think to
divide two numbers, and a person acting on a hold is not going to do arithmetic.

`basis` keeps two facts apart that would otherwise collapse: **`db-unavailable` means the lookup
could not run, `no-owning-row` means it ran and found nothing.** Could not look is not the same as
looked and found nothing.

The resolver never throws and a broken lookup does not close the door, matching the posture this
route already takes on its limiter (metered as a SAFETY route: throttled, never denied by a broken
check). A safety door that shuts when a database hiccups is a safety door that is not there.

Covered by `tests/abuse-report-key-scope.test.ts`, 18 cases. The denominator case asserts every one
of the twelve `ARTIFACT_PREFIXES` members is classified derivable or not and that the two sets
partition the list, so a thirteenth prefix cannot arrive without someone deciding which side it is
on. Controls in both directions: an in-project key is accepted and removed, an out-of-project key is
refused and its original survives, and a broken lookup still files the report.
