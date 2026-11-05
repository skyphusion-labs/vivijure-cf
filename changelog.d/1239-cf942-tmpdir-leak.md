### fix(tests): stop the test suite leaking temp dirs

`tests/module-binding-requirements-942.test.ts` created 8 `cf942-*` dirs under `$TMPDIR` on every vitest run and never removed them. `tests/changelog-assemble.test.py` did the same with 3 `asm-holds-*` dirs per run. Both now track each dir they create by exact path and remove it (vitest `afterEach`; Python explicit removal plus `atexit`), and each has a regression check that fails if any dir it created survives the run. Cleanup never deletes by glob, so a concurrent run of the suite keeps its own fixtures.
