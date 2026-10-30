### fix(finish): a finish retry says why it did not start (#1114)

`POST /api/render/film/:id/finish-retry` answered "no finish step to retry" for a film that was only busy. The 409 now has a `code`: `busy` with `Retry-After: 30`, `nothing_to_retry`, or `cannot_deliver`. With core 1.28.3, `clip_deliveries` reports the frames a clip has, and marks them `measured: true` (#1125).
