#!/usr/bin/env python3
"""cf#480 mutation proof.

For every guard this PR ships, reintroduce the defect it exists to catch and prove a test goes RED
FOR ITS NAMED REASON. Three properties this harness has on purpose:

  * IT ASSERTS THE MUTATION APPLIED. A str.replace that matches nothing is silent, and a mutation
    that never landed produces a GREEN run that reads exactly like "the guard did not fire".
  * IT CHECKS FOR THE RIGHT RED, not merely red. A run can go red because an unrelated case broke,
    or because the harness itself died, and both look like a working guard.
  * IT PRINTS A DENOMINATOR. `mutations N of M` so an empty loop cannot report a clean sweep.

Restores by `git checkout --` which is safe here and ONLY here: the tree is committed and clean
before this runs, asserted below, so there is no uncommitted work for it to destroy.
"""
import subprocess, sys, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIN = "modules/finish-upscale/src/index.ts"
SHARED = "modules/_shared/finish-door.ts"
SUITE = "tests/finish-door-cf480.test.ts"
READY = "tests/module-ready.test.ts"

MUTATIONS = [
    dict(
        id="M1-affinity-ignored",
        why="poll picks the transport from CURRENT config instead of from the token",
        f=FIN,
        old="  if (tokenTookDoor(st.door)) {\n    const door = await doorFor(env);",
        new="  if (doorBound(await doorFor(env))) {\n    const door = await doorFor(env);",
        suites=[SUITE],
        victims=["a RunPod-minted token polls RUNPOD even though a door is bound"],
    ),
    dict(
        id="M2-failover-to-runpod",
        why="a door failure falls through to RunPod, re-renting the GPU this change removes",
        f=FIN,
        old="    if (problem) return passthrough(input, problem);\n    return submitVia(env, req, doorTransport(door));",
        new="    if (problem) return passthrough(input, problem);\n    const attempt = await submitVia(env, req, doorTransport(door));\n    if (!(attempt.output as { degraded?: string } | undefined)?.degraded) return attempt;",
        suites=[SUITE],
        victims=["a door FAILURE degrades honestly and STILL does not touch RunPod"],
    ),
    dict(
        id="M3-token-label-dropped",
        why="the poll token stops recording which transport minted the job",
        f=FIN,
        old="        door: t.name || undefined,",
        new="        door: undefined,",
        suites=[SUITE],
        victims=["submit -> poll round trip keeps the label"],
    ),
    dict(
        id="M4-runpod-headers-dropped",
        why="the Transport indirection drops the caller's headers on the RunPod arm",
        f=FIN,
        old="    call: (path, init) => fetch(runpodBase(route, endpointId) + path, {\n      ...init,\n      headers: { ...auth(route), ...(init?.headers as Record<string, string> | undefined) },\n    }),",
        new="    call: (path, init) => fetch(runpodBase(route, endpointId) + path, {\n      ...init,\n      headers: { ...auth(route) },\n    }),",
        suites=[SUITE],
        victims=["finish-upscale still builds RunPod's own URL, method and headers"],
    ),
    dict(
        id="M5-tokenless-door-falls-back",
        why="a bound-but-tokenless door reads as UNBOUND and silently resumes renting RunPod",
        f=SHARED,
        old="  if (!binding) return { binding: null, name: \"\", token: \"\" };",
        new="  if (!binding || !token) return { binding: null, name: \"\", token: \"\" };",
        suites=[SUITE],
        victims=["bound WITHOUT a token is propagation", "bound but tokenless degrades as PROPAGATION"],
    ),
    dict(
        id="M6-ready-shape-unconditional",
        why="/ready emits the door key unconditionally, editing the module-agnostic shape contract",
        f=FIN,
        old="        ...(onDoor ? { door: { bound: true, token: !doorProblem(door), route: DOOR_ROUTE_NAME } } : {}),",
        new="        door: { bound: onDoor, token: onDoor && !doorProblem(door), route: onDoor ? DOOR_ROUTE_NAME : null },",
        suites=[SUITE, READY],
        victims=["UNBOUND: no `door` key at all", "reports ok with both credentials visible"],
    ),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=REPO, shell=True, capture_output=True, text=True)


def clean():
    return sh("git status --porcelain").stdout.strip() == ""


if not clean():
    sys.exit("REFUSING: working tree is not clean. This harness restores with `git checkout --`, "
             "which destroys uncommitted work (N99). Commit first.")

# CONTROL: the suites must be GREEN before any mutation, or a red below proves nothing.
base = sh("npx vitest run " + " ".join(sorted({s for m in MUTATIONS for s in m["suites"]})))
if base.returncode != 0:
    sys.exit("REFUSING: baseline is already red -- a mutation's red would be indistinguishable.\n"
             + base.stdout[-3000:])
print("BASELINE GREEN across", len(sorted({s for m in MUTATIONS for s in m["suites"]})), "suites\n")

passed = 0
report = []
for m in MUTATIONS:
    path = os.path.join(REPO, m["f"])
    src = open(path).read()
    n = src.count(m["old"])
    if n != 1:
        sys.exit("MUTATION %s: anchor matched %d times, expected 1 -- a mutation that does not "
                 "apply produces a GREEN run that reads like a working guard" % (m["id"], n))
    open(path, "w").write(src.replace(m["old"], m["new"]))
    try:
        r = sh("npx vitest run " + " ".join(m["suites"]))
        out = r.stdout + r.stderr
        went_red = r.returncode != 0
        named = [v for v in m["victims"] if v in out]
        ok = went_red and named
        report.append((m["id"], m["why"], went_red, named, m["victims"]))
        if ok:
            passed += 1
        print("%-30s red=%-5s named_victims=%d/%d" % (m["id"], went_red, len(named), len(m["victims"])))
    finally:
        sh("git checkout -- " + m["f"])
        if not clean():
            sys.exit("RESTORE FAILED after %s -- stop and inspect" % m["id"])

print("\nmutations proven: %d of %d" % (passed, len(MUTATIONS)))
for mid, why, red, named, victims in report:
    print("  %s: %s" % (mid, why))
    print("      red=%s  named=%s" % (red, named or "NONE -- red for an UNNAMED reason"))
if passed != len(MUTATIONS):
    sys.exit("NOT ALL GUARDS PROVEN")
