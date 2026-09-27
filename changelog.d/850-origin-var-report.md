### ci(deploy): report which media doors the core render actually BOUND, and refuse the one contradiction (cf#850)

cf#840 closed the module render's silent-strip. **The CORE render had the same shape and nothing reported
there.** Its fail-closed check is `grep -qF '${'` over non-comment lines, which catches a var MISSING
from the `envsubst` shell-format list because the literal `${FOO}` survives. It cannot catch a var that
is **listed and empty**: `envsubst` substitutes it to `""`, the config reads `FINISH_UPSCALE_DOORS = ""`,
every guard in the step passes, and the deploy is green with the door off. A deliberate opt-out and a
forgotten variable render byte-identically, so nothing downstream can tell them apart.

**Measured on the real committed template rather than a fixture**, which is also the proof of the gap:
render `wrangler.toml.example` through `strip-local-gpu.sh` and `envsubst` with the live repo-variable
values and the new reporter prints `7 bound, 0 empty`, exit 0. Unset one var and line 110 renders
`VIDEO_FINISH_URL = ""`; the reporter warns, then refuses, exit 1. **And the pre-existing placeholder
guard PASSES on that same file** -- it is structurally blind to the state, which is what this closes.

**It reports rather than fails on empty, and that is deliberate.** The template documents empty as
meaningful ("Empty = that service is off") and the three door-list modules read an empty list as "use
RunPod", so a self-host legitimately ships most of these empty. A gate that is wrong about the ordinary
case gets routed around, and a routed-around gate costs more than no gate because it also costs the next
author an argument. So every door is named `BOUND` or `EMPTY`, each empty one gets a `::warning::`, the
denominator is printed, and the exit status is unchanged.

**The one hard fail is a contradiction inside a single config, not an opinion about which tiers we run.**
If the config binds `[[containers]]` while `VIDEO_FINISH_URL` renders empty, the finish container IS the
door (cf#810: `MEDIA_DOOR_FETCHERS` is keyed by the var NAME and synthesised from the binding, so the
value is never fetched) but `src/video-finish-availability.ts` reads a non-empty var as "the tier is
installed". That deploy degrades the assemble phase while a working door sits bound. The two halves of
one file disagree, which is a state an operator arrives at by accident rather than chooses.

**Both directions are pinned, because a one-sided control is the defect this issue is about.**
`tests/origin-vars-report-cf850.test.ts` drives the shipped script: a fully bound config passes naming
every door; an optional door left empty stays GREEN and is reported; the same empty `VIDEO_FINISH_URL`
goes RED **with** a `[[containers]]` block and stays GREEN **without** one, which is the pair that
matters -- identical var state, opposite verdicts, decided by the other half of the config. Without that
second case the refusal would read as "empty VIDEO_FINISH_URL is banned", which would be wrong about
every self-host. Plus: a render with no door vars at all is could-not-measure rather than a pass, a
missing file fails rather than skips, and no origin VALUE is ever printed on any path.

**Wired to the render that uses REAL values, and deliberately to no other.** `bundle-gate`,
`container-deploy-shape` and `studio-release` render the same template with EMPTY or dummy
substitutions on purpose, so all three would hit the contradiction refusal for a reason that is not a
defect. The test pins the single live invocation in the deploy job AND its absence from the others,
because **this is a control that would be WRONG if generalised** -- worth pinning rather than leaving to
whoever reads the file next.

## The reachability question, PRICED and not built

A `BOUND` report is about the CONFIG, not the world: measured 2026-09-27, **eleven of the thirteen
hostnames across these seven vars were NXDOMAIN while every var was non-empty**. Three options, with
what each buys and costs:

1. **DNS resolve per door host, report-only, in the deploy log.** ~7 lookups, under a second, no egress,
   no auth. Would have caught all eleven. Cannot see a host that resolves but is dead. Roughly five
   lines next to the reporter.
2. **HTTP HEAD/GET per door with a short timeout.** Catches a dead host too, but needs
   `MEDIA_FINISH_TOKEN` to avoid 401s, and it puts a **network dependency in a release gate**: a door
   being down would block an unrelated release.
3. **Readiness instead of CI.** The studio already has a hook/availability surface; reachability is a
   property of the running system, and asking it there answers "is the tier up now" rather than "was it
   up when we deployed".

Recommendation: (1) as a non-blocking report, and (3) for the real answer. **Not (2) in a deploy gate.**
Left to a ruling rather than assumed, because adding a network dependency to the release path is a
posture decision, not a tweak.
