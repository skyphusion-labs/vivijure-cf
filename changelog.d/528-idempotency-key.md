Panel film submits send a per-click `idempotency_key`. The host
forwards it into core so a 5xx retry or double-post is one film,
not two GPU bills. The 60s natural-key path stays the backstop.

Also: animate-cloud error path had an extra `)` that made
`planner-history-row.js` unparseable (found via node --check).
