### fix(rate-limit): meter the paid cast voice-sample route (cf#790)

`POST /api/cast/:id/voice-sample` invokes a paid `motion.backend` (Seedance by
default, any installed talking door via `motion_backend`), so one request is one
paid image-to-video job. It was in neither `SPEND_PATTERNS` nor the storage
list, so a consumer token could loop `{"seconds":10}` for unbounded paid video
with no rate limiter, no daily ceiling and no quota. Now metered, fail-closed
like every other money route, with no `isSafetyRoute` carve-out: refusing a cast
preview on a broken limiter is retryable, an unbounded bill is not.
`/voice-sample/keep` and `/voice-sample/attach` stay unmetered here by design.
