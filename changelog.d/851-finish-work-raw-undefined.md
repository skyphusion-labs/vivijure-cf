### fix(video-finish): `_finish_work` passed an undefined name, so every non-remux finish failed (cf#851)

With the container finally able to START (the `concat_guard.py` COPY fix), the next request down
the `/async/finish` path failed with `name 'raw' is not defined`. Film `film-443ae588` reached
`assemble`, the job container reached `running` for the first time, and then the handler raised.

`app.py:403`, inside `async def _finish_work(body)`:

```python
partial_urls = _parse_partial_urls(raw)   # `raw` is never bound anywhere in app.py
```

The enclosing parameter is `body`, every other read in the function uses `body`, and the very next
line passes `body` to `_finish_chunked(body, partial_urls, t0)`. One call site, one word.

Introduced by `0cdd5fc` (#801, chunked assemble) at 2026-09-27T01:52:20Z, **34 minutes after the
COPY defect that made it unreachable.** It has been latent ever since for the only reason that
matters: the container could not start, so this line never executed. Fixing the startup crash is
what surfaced it.

**WHY THE SUITE DID NOT CATCH IT, which is the part worth keeping.** The chunked tests call
`_parse_partial_urls()` and `_finish_chunked()` **directly**:

```
_finish_chunked(      5 call sites in tests
_parse_partial_urls(  4 call sites in tests
_finish_work(         0
```

Both pieces either side of the defect are well covered. **Nothing calls the function that joins
them**, so the wiring between two tested components was the one untested line, and a green suite
said nothing about it. That is the stubbed-seam shape: the decision paths were proven and the
shipped path was not.

**A linter would have caught this at zero cost, and there is no Python linter in CI at all.**
Measured rather than asserted, against the unfixed file:

```
app.py:403:40: undefined name 'raw'
```

`py_compile` passes on the broken file, because a `NameError` is a runtime event and not a syntax
one, so "it imports" was never evidence. cf#874 tracks adding an undefined-name gate over
`containers/**/*.py`; it is deliberately not bundled here, because switching a linter on across
five containers is a sweep and this is a one-word fix to a live outage.

Verified: pyflakes reports the undefined name before and not after; the five standalone container
suites (`chunked_contract`, `concat_guard`, `upload_streams`, `url_guard`, `bearer`) all exit 0.
