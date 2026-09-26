### fix(api): tighten report endpoint object handling and add metering

`POST /api/report` key scoping and metering hardened; the door is metered as a
SAFETY route, so a broken or unbound limiter throttles it but can never deny it.

Tracked under GHSA-wmjq-7647-h45x. Details stay in the advisory.
