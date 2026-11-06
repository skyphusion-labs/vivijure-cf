### refactor(tail): the tail Worker entry exports only its handler

`deriveFields`, `shapeEventsToLoki` and `reportSinkDrop`, with the event and stream types they use, move from `tail/src/index.ts` into `tail/src/shape.ts`. The entry keeps `Env`, the push and the handler. Behaviour is unchanged. Its `BASELINE` line in `tests/worker-entry-exports-1244.test.ts` is gone (refs vivijure-cf#1308).
