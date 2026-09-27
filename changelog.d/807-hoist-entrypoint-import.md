### fix(tests): stop billing the worker entrypoint's import to a single test case (cf#807)

Two cases sat at roughly a 2.7x margin under the 5000ms `testTimeout` and flipped to red on machine
speed rather than on code. The cause is not that the work is large. It is that both files reached
`src/index` through `await import("../src/index")` from **inside a test body**, so the one-time cost
of transforming and importing a 92-route module graph was charged against whichever case happened to
trigger it first.

Measured on this suite, not inferred from the shape:

- a case whose entire body is `await import("../src/index")` takes **2049ms**; a second import takes
  **0ms**;
- the two named cases took **1192ms** and **1194ms** while every sibling case in the same two files
  took **0-3ms**.

So the case was measuring the import, and the code under test contributed about 1ms.

Denominator, because the population matters: of 251 test files, **41** import `src/index`
statically, and a static top-level import is paid during collection and is billed to no case.
**Exactly 2** imported it dynamically from inside a case, and those 2 are precisely the two files in
the issue. The correlation is total.

The fix hoists the import into `beforeAll`, which is charged to `hookTimeout` (10000ms) rather than
to any case. A static import, which is what the other 41 suites use, is **not** available in these
two files: `vi.mock` is hoisted above the module body, so a static import of `src/index` would run
the mock factory before the `vi.fn` consts it closes over are initialised.

Result: **1192ms to 23ms** and **1194ms to 24ms**. The margin under the default timeout goes from
2.7x to about 208x, and the number a case reports is now a property of the code it exercises.

Watched it go red: replacing the hook body with `API_ROUTES = []` fails all 7 cases in
`patch-module-config-387.test.ts` with `route PATCH /api/modules/:name/config is not in API_ROUTES`,
so the speedup is not the tests quietly ceasing to run. `testTimeout` is left at its default; nothing
was raised to buy the pass.
