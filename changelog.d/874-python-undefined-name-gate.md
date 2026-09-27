### ci(python): fail on an undefined name, because nothing in this repo was asking (cf#874)

`grep -rniE "ruff|pyflakes|flake8|pylint" .github/workflows/` returned **nothing**. There was no Python
linter in CI at all, and it cost two live outages in one night. The second:
`containers/video-finish/app.py` called `_parse_partial_urls(raw)` inside `_finish_work(body)` where
`raw` was never bound, so **every non-remux finish raised `NameError`** until `cedba5a` (PR #875).

**Why nothing caught it.** `py_compile` passes on that file, because a `NameError` is a runtime event
and not a syntax one, so "it imports" was never evidence. The unit suite covers `_finish_chunked` (5
call sites) and `_parse_partial_urls` (4) and `_finish_work` (0): both components tested, **the line
joining them untested**, and no realistic unit test would have covered it without standing up the whole
handler. And the cf#857 smoke gate cannot see it either -- `/health` answers, the process is healthy,
and the defect sits on a handler path a boot check never touches. Three layers now, each with a stated
boundary, none a substitute for another.

**`scripts/lint-python-undefined.sh`** runs pyflakes over every tracked `*.py` (68 of them, derived from
`git ls-files` rather than a hand-scoped subdirectory, because the defect class is not
container-specific and a hand-kept list is the artifact that drifts).

- **Undefined names FAIL.** That is the class that shipped.
- **Style is REPORTED and does not block.** Unused imports, unused locals and placeholder-less
  f-strings print as `::warning::`. Nine such findings existed when this landed and are visible in the
  step's log. A gate that fails a release over an unused import is a gate somebody deletes, and then it
  is a gate nobody runs.
- **pyflakes, PINNED at 3.4.0.** A linter whose ruleset moves under you is a gate whose findings change
  with no commit. `ruff --select F` is the same ruleset plus a large surface that would need
  configuring to stay quiet; if the repo ever wants that, this script is what it replaces.

**The control is the load-bearing half, because this gate decides by MATCHING TEXT** (`undefined name`)
in the linter's output. A reworded or silent pyflakes would stop failing and read green forever. So
`tests/lint-python-undefined.test.sh` drives the shipped script against fixtures and asserts the exact
exit status plus the reason on each:

| case | expected |
|---|---|
| undefined name | **1** |
| clean file | **0** (the positive control; without it the gate might always fail) |
| unused import only | **0**, with a non-blocking warning |
| no `.py` in the population | **1**, could-not-measure is not a pass |
| linter missing | **2**, an unavailable instrument is a failure and not a skip |
| **linter that reports NOTHING** | **2**, the gate must REFUSE rather than pass |

That last case is the one that makes the rest mean anything: a clean result from a silent instrument is
indistinguishable from a clean tree. It uses a stub written by the test, after the first version reached
for `/bin/true` and got the right exit code **for the wrong reason** (`not found`: macOS has only
`/usr/bin/true`). The reason assertion caught it; an exit-code-only check would have called it a pass.

**Both directions on the real artifact, no planted defect**, exactly as the issue required. Run against
two worktrees:

```
cedba5a~1 (ff7f542)  containers/video-finish/app.py:443:40: undefined name 'raw'   exit 1
origin/main (8499bc2)  no undefined names in 68 file(s)                            exit 0
```

Wired into `container-tests`, which already runs unconditionally and is already in the `deploy` job's
`needs`, so this gates a release without adding a new conditional dependency to the release path.
