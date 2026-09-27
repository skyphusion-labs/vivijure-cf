### feat(release): the module release manifest carries the bindings a module DECLARES (cf#942)

The manifest carried `{module, main_module, compatibility_date, compatibility_flags, worker}` and no
bindings at all, so the array the control plane builds at upload WAS the complete binding set a
tenant module got -- derived from a hand-maintained catalog on the other side of a repo boundary.
That is why four catalogued motion doors and the hosted `dialogue` door cannot be given their
Workflows binding: nothing tells the plane they need one.

`build-module-release.ts` now reads each module's own `[[workflows]]` blocks out of the
`wrangler.toml` the bundle was built from, and publishes them as `bindings_required.workflows`:

```json
"bindings_required": { "workflows": [
  { "binding": "DIALOGUE_WORKFLOW", "class_name": "DialogueGenWorkflow", "name": "dialogue-gen" }
] }
```

**The split is by who can possibly know each part.** The module knows WHAT it needs, and its own
config is the only copy of that fact which cannot drift from the code calling `env.X.create()`. Only
the plane knows WHO it is for, so the plane composes the account-scoped resource name from the
tenant, exactly as it already derives the script name. Neither half is hand-maintained, which is the
point: a triple typed into `TENANT_MODULE_CATALOG` would be the third hand-maintained list to rot in
this estate in a month.

**Always present, even empty, and that is load-bearing rather than tidy.** `"workflows": []` means
"declares none"; the whole field being ABSENT means the artifact predates this contract and cannot
say. Only the second is a reason for a consumer to refuse, and collapsing them is how a module that
needs a binding provisions silently unbound -- which the live API measurably accepts
(vivijure-control-plane cp#526), so it is invisible until the first invoke.

A partial `[[workflows]]` block (missing `binding`, `class_name` or `name`) fails the RELEASE BUILD
rather than publishing a requirement the plane cannot act on: at build beats at provision, and at
provision beats a green install that throws.

The parser is line-oriented and tracks the current table header, because the alternatives produce a
plausible wrong answer rather than an error: a pattern matching `name =` anywhere picks up the
worker's own top-level name, and a block reader that does not stop at the next header absorbs
`binding` from the `[[secrets_store_secrets]]` block that follows in six of these files. Both traps
have a test, and both were watched RED against a mutation that removed the header boundary -- along
with a third case that only discriminates because the mutation showed it did not.
