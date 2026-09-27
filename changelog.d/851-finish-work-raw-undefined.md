### fix(video-finish): `_finish_work` passed an undefined name, so every assemble failed (cf#851)

With the container finally able to START (the `concat_guard.py` COPY fix in v1.34.2), the next
request down the `/async/finish` path failed with `name 'raw' is not defined`. Film
`film-443ae588` reached `assemble`, the job container reached `running` for the first time, ran
for **620 seconds**, and then the handler raised.

`app.py`, inside `async def _finish_work(body)`:

```python
partial_urls = _parse_partial_urls(raw)   # `raw` is never bound anywhere in app.py
```

The enclosing parameter is `body`, every other read in the function uses `body`, and the next line
passes `body` to `_finish_chunked(body, partial_urls, t0)`. One call site, one word.

**The line is unconditional, above the chunked branch, so it broke every assemble and not only the
chunked path.** Introduced by `0cdd5fca6` (#801) at 2026-09-27T01:52:20Z, **34 minutes after the
COPY defect that made it unreachable** -- two container-breaking bugs from the same hour, the
first masking the second for six hours, because nothing could reach this line while the process
was dying at `app.py:32`.

**WHY THE SUITE DID NOT CATCH IT, which is the part worth keeping.**

```
_parse_partial_urls   3 references in test_chunked_contract.py, 2 in test_local_chunked.py
_finish_chunked       5 references in tests
_finish_work          0 references anywhere in the suite
```

The helper was proven correct and passing all night. **The single line that invokes it was never
executed by a test.** Both components either side of the defect were covered; the wiring between
them was not.

`tests/../test_finish_work_call_site.py` now enters `_finish_work` for real and reaches that line.
`_finish_chunked` is the ONLY thing stubbed, so `_parse_partial_urls` and all the validation above
the call site run for real; stubbing the helper would have re-tested the half that already worked.
**Driven RED against the shipped line first** (6 failures, exit 1) and green after (exit 0), and it
carries two controls: a NameError planted at the call site must be caught and reported, and that
planted failure must stop the run before `_finish_chunked`, so the assertions cannot pass on a run
that never reached the line at all.

**A draft of that test made a real network call while its own docstring said "no network".** The
no-pool branch falls through to the download path; it failed with an SSL handshake error against
`r2.cloudflarestorage.com` and **still reported PASS**, because the assertion was "did not raise
NameError" and any other exception satisfies that. It would have gone on passing with the call
site arbitrarily broken. That case is removed and its absence is documented in the file rather
than left as a silent gap.

**A linter catches this class for nothing and there is no Python linter in CI at all**
(`app.py:443:40: undefined name 'raw'`, measured on the unfixed file). `py_compile` passes,
because a `NameError` is runtime and not syntax, so "it imports" was never evidence. cf#874 tracks
the gate.
