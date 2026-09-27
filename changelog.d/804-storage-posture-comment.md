### docs(storage): the storage ceiling does not share the spend gate's posture (cf#804)

The comment above the storage-quota check in `src/index.ts` said *"Same posture as the spend gate
above"*. It is not, and the difference is operationally load-bearing: the two gates are driven by
different knobs, so an operator reading that line would reach for `SPEND_LIMIT_FAIL_CLOSED` to change
a posture it does not control.

- **spend gate:** `SPEND_LIMIT_FAIL_CLOSED`, default closed; a broken check is a 503 deny.
- **storage ceiling:** core's `R2_STORAGE_QUOTA_MODE`, `deny` (default) or `meter`. Unset, empty or
  any unrecognised value resolves to `deny` with a console warning, deliberately, because guessing
  `meter` on a typo would silently turn a hard stop into unmetered spend.

And `meter` does not merely soften the deny. It changes what a **broken** check does: with no DB or a
failed usage read, `deny` answers 503 fail-closed while `meter` lets the submit **proceed** and
reports the period as an unbillable metering gap. The two gates disagree about the broken case in the
one direction that costs money, which is exactly the thing the old comment flattened.

Comment only; no behaviour change. It is the fifth instance this sprint of a comment asserting a
property the code does not hold, and this one sits in a spend path.
