### test(storage): the R2 storage ceiling can now be watched failing in CI (cf#811)

The storage-quota gate can answer 507, and its fail-closed posture can answer 503, and neither had a
test. `git grep -ln "checkStorageQuota\|R2_STORAGE_QUOTA_BYTES" -- tests/` returned nothing, so the
control had never been observed going red and a refactor that silenced it would have landed green.

18 cases driving `worker.fetch` at the wire, not `checkStorageQuota` directly. That distinction is
the point: a unit test of core's function stays green through the exact regression this file exists
to catch, which is someone deleting the `isPanelStorageSubmitRoute` block from `src/index.ts`.

Telling the two 503s apart is the whole difficulty, and it is why no case here asserts on a bare
status. The spend gate sits immediately above this one and also fails closed to 503 on a broken
check, so every case binds a PASSING `SPEND_RATE_LIMITER` and asserts on the MESSAGE. A case that
asserted only `status === 503` would pass with the storage gate deleted outright.

Covered: the 507 on all four panel-supplement routes; the 503 for an unbound DB and, separately, for
a usage read that throws; `meter` mode declining to deny and declining to 503; an unrecognised mode
falling back to `deny` rather than to `meter`; an unstamped ledger still denying at the ceiling; and
`SPEND_LIMIT_FAIL_CLOSED` having no effect on this gate, which is what stops the two being
"unified" on the strength of the comment cf#804 corrected.

Nine of the eighteen are CONTROLS, because N refusals are equally consistent with N routes that are
simply broken in the fixture env: each route is also driven with usage UNDER the ceiling and must be
admitted, the knob is unset to show the refusal is caused by the knob, and `/voice-sample/keep` must
NOT be gated so the anchored patterns cannot quietly widen. A DENOMINATOR case asserts the file has
one route per entry in `PANEL_STORAGE_SUBMIT_PATTERNS`, so a fifth byte-writing route fails here
rather than going silently uncovered.

Watched it go red, twice, because a gate that has never been seen to fail is decoration:

- removing the gate block from `src/index.ts` fails **9 of 18**, every refusal case, while all nine
  controls stay green;
- narrowing `isPanelStorageSubmitRoute` back to core's list alone (the fc#2250 defect shape, where
  the ceiling denied the front door and left the side door open) fails the same 9.

Test-only. No behaviour change, and `R2_STORAGE_QUOTA_BYTES` remains off by default.
