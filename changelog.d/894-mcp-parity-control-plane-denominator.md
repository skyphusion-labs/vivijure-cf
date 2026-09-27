### fix(deps+docs): vivijure-mcp 1.3.0, and a parity denominator that can hold two surfaces (cf#894)

`@skyphusion-labs/vivijure-mcp` 1.2.1 -> 1.3.0. The bump was red because
`tests/mcp-parity-317.test.ts` asserts a published denominator, which is the test working: the
catalog changed shape and the doc had to change with it.

**The growth is not what the issue assumed, and measuring it first changed the work.** 42 -> 109 is
**37 new `cp_*` control-plane tools AND 30 new STUDIO tools**, not ~67 control-plane ones. Nothing
was removed. The 30 studio tools are why curated route coverage moved **41 -> 70 of 92** rather
than staying flat: module config, storage, prefs, demo, clips, frames and identity all gained
purpose-built tools.

**Split by CALL TARGET, not by name prefix.** Measured on 1.3.0: **37 tools are named `cp_*` and 38
build a call with `target: "control_plane"`.** The one that differs is `control_plane_request` -- a
control-plane escape hatch that a prefix test files as a studio tool. A name is a convention; the
call's target is the contract. The disagreement is pinned by its own case so it cannot quietly
become two.

**`curatedCoverage()` was iterating every tool and skipping one name.** Control-plane tools' paths
were going into the studio-route coverage map, and `control_plane_request` was being treated as a
curated tool. Measured: **0 of 38 control-plane tools collide with a studio route key today** -- but
only because control-plane paths happen to live under `/api/admin` and `/api/platform`, which
nothing maintains against the route table. That accident is now a rule: a test asserts the
collision set is empty *and* that there was a population to collide with, so a zero cannot come
from an empty list.

`PUBLISHED` now carries three tool numbers instead of one (`tools` 109, `studioTools` 71,
`controlPlaneTools` 38) and asserts they reconcile, so a third target would fail to add up rather
than vanish from both denominators. Route-relative counts are measured against studio tools only,
because a control-plane tool cannot reach a studio route.

Re-measured with 1.3.0: curated coverage **41 -> 70**, panel-reachable-with-no-curated-tool
**34 -> 15**, path-only **38 -> 19**. `docs/mcp-parity.md` updated in the same change, which the
suite enforces.

Also fixes the sub-item the issue diagnosed: `placeholderArgs()` had no `boolean` case, so a
required boolean fell through to the string `"PLACEHOLDER"` and 1.3.0's `set_module_enabled` threw
`'enabled' must be a boolean` inside `build()`. **A missing type in that switch does not report as a
missing type; it reports as whatever the tool does with a string it did not ask for.**

Supersedes dependabot #676, which carried the bump without the denominator work.
