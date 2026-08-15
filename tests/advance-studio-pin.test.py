#!/usr/bin/env python3
"""Drive every arm of scripts/advance-studio-pin.sh against a local stand-in for the GitHub API
(cf#372).

WHY A LOCAL SERVER RATHER THAN STUBS: the thing under test is a shell script that talks HTTP. A
stub of `curl` would encode the author's assumption about what curl does; a real request against a
real socket exercises the shipped command line, the real jq parsing and the real exit codes. Only
the API BASE is redirected, and the script announces that redirection on every such run.

THE ASSERTIONS THAT MATTER ARE THE ONES ABOUT REQUESTS NOT SENT. A refusal that still issued the
PATCH would print a refusal and change hosted anyway, and an exit-code-only test cannot tell those
apart. So every declining case asserts the recorded PATCH count is ZERO.

Each case asserts the NAMED reason, never merely a non-zero exit: a test that accepts any failure
passes identically when the script dies for an unrelated reason.
"""
import json, os, pathlib, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "advance-studio-pin.sh"
CANONICAL = "skyphusion-labs/vivijure-cf"

failures = []
checks = 0


def check(name, ok, detail=""):
    global checks
    checks += 1
    if ok:
        print("  ok   " + name)
    else:
        print("  FAIL " + name + (" -- " + detail if detail else ""))
        failures.append(name)


class Stub:
    """One request log, one scripted GET sequence, one scripted PATCH status."""

    def __init__(self, get_bodies, get_status=200, patch_status=204):
        self.get_bodies = list(get_bodies)
        self.get_status = get_status
        self.patch_status = patch_status
        self.requests = []  # (method, body)
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, payload):
                b = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                outer.requests.append(("GET", None))
                body = outer.get_bodies.pop(0) if outer.get_bodies else {"message": "no fixture left"}
                self._send(outer.get_status, body)

            def do_PATCH(self):
                n = int(self.headers.get("content-length") or 0)
                outer.requests.append(("PATCH", self.rfile.read(n).decode()))
                if outer.patch_status == 204:
                    self.send_response(204)
                    self.send_header("content-length", "0")
                    self.end_headers()
                else:
                    self._send(outer.patch_status, {"message": "denied"})

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def patches(self):
        return [r for r in self.requests if r[0] == "PATCH"]

    def stop(self):
        self.httpd.shutdown()


def run(tag, stub, token="fixture-not-a-real-token", repo=CANONICAL, args=()):
    env = dict(os.environ)
    env["STUDIO_PIN_API_BASE"] = stub.base
    env.pop("STUDIO_PIN_VARIABLE_TOKEN", None)
    env.pop("GITHUB_REPOSITORY", None)
    if token is not None:
        env["STUDIO_PIN_VARIABLE_TOKEN"] = token
    if repo is not None:
        env["GITHUB_REPOSITORY"] = repo
    p = subprocess.run(["bash", str(SCRIPT), tag, *args], capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr

def val(v):
    return {"name": "STUDIO_RELEASE", "value": v}


# 1. Absent credential ON THE CANONICAL REPO: FAILS, and issues no request at all.
#
# This case asserted rc == 0 until cf#372. That was the defect, sanctioned in the script comments:
# the secret was never provisioned, the step warned and exited 0 on the v1.27.0 and v1.28.0 tags,
# both runs reported success, and the hosted pin sat at v1.26.0 while the deployed studio reached
# v1.28.0. An annotation is not a gate. The test encoded the same belief the script did, so the
# suite could not have caught it either -- which is why the expectation itself had to move.
s = Stub([val("v1.20.0")])
rc, out = run("v1.26.0", s, token=None)
check("absent credential on the canonical repo FAILS the release", rc == 1, "rc=%d" % rc)
check("the failure names the missing secret and how to provision it",
      "STUDIO_PIN_VARIABLE_TOKEN is unset" in out and "Variables: read and write" in out)
check("absent credential still sends ZERO requests", len(s.requests) == 0, str(s.requests))
s.stop()

# 1b. THE CONTROL for 1: the same absent credential on a FORK is a legitimate skip, so the fix
# fails closed on the release path without breaking every fork and self-host build. Without this
# case, a script that simply failed on every absent credential would pass case 1 identically.
s = Stub([val("v1.20.0")])
rc, out = run("v1.26.0", s, token=None, repo="someone-else/vivijure-cf")
check("CONTROL: absent credential on a FORK skips green", rc == 0, "rc=%d" % rc)
check("the fork skip names the repository it compared against",
      "someone-else/vivijure-cf" in out and CANONICAL in out)
check("the fork skip sends ZERO requests", len(s.requests) == 0, str(s.requests))
s.stop()

# 1c. Ambiguity fails CLOSED. An unset GITHUB_REPOSITORY must not read as probably a fork: that is
# the same reasoning that produced the original defect, an absent thing treated as a benign one.
s = Stub([val("v1.20.0")])
rc, out = run("v1.26.0", s, token=None, repo=None)
check("an unidentified repository fails CLOSED, not open", rc == 1, "rc=%d" % rc)
check("the ambiguous failure says the repository was unidentified",
      "an unidentified repository" in out)
s.stop()

# 2. Malformed tag: refuses before touching anything.
s = Stub([val("v1.20.0")])
rc, out = run("latest", s)
check("a non-vX.Y.Z tag is REFUSED", rc == 1 and "is not a vX.Y.Z tag" in out, "rc=%d out=%s" % (rc, out[-200:]))
check("a malformed tag sends ZERO requests", len(s.requests) == 0, str(s.requests))
s.stop()

# 3. The key is ABSENT from the response. It must not be coerced into a value: "absent" and "set to
#    something old" are different findings and only one of them is a pin this script may move.
s = Stub([{"message": "Not Found"}], get_status=404)
rc, out = run("v1.26.0", s)
check("an ABSENT value key REFUSES instead of coercing", rc == 1 and "carries no value field" in out,
      "rc=%d out=%s" % (rc, out[-200:]))
check("an absent key sends ZERO patches", len(s.patches()) == 0, str(s.requests))
s.stop()

# 4. Already current.
s = Stub([val("v1.26.0")])
rc, out = run("v1.26.0", s)
check("an already-current pin is a no-op", rc == 0 and "nothing to advance" in out, "rc=%d" % rc)
check("an already-current pin sends ZERO patches", len(s.patches()) == 0, str(s.requests))
s.stop()

# 5. BACKWARDS. studio-release.yml is dispatchable for rebuilds of older tags; advancing on one
#    would repoint every future tenant at older code -- this script's own defect, self-inflicted.
s = Stub([val("v1.26.0")])
rc, out = run("v1.20.0", s)
check("a backwards move is REFUSED", rc == 0 and "refusing to move the pin backwards" in out,
      "rc=%d out=%s" % (rc, out[-200:]))
check("a backwards move sends ZERO patches", len(s.patches()) == 0, str(s.requests))
s.stop()

# 5b. The positive control for case 5: same shape, direction reversed, so the refusal above is
#     shown to be about the DIRECTION rather than about the script refusing everything.
s = Stub([val("v1.20.0"), val("v1.26.0")])
rc, out = run("v1.26.0", s)
check("a forwards move is ACCEPTED (control for the backwards refusal)", rc == 0, "rc=%d out=%s" % (rc, out[-200:]))
check("the forwards move sends exactly one PATCH", len(s.patches()) == 1, str(s.requests))
sent = json.loads(s.patches()[0][1]) if s.patches() else {}
check("the PATCH carries the released tag", sent.get("value") == "v1.26.0" and sent.get("name") == "STUDIO_RELEASE",
      str(sent))
check("the advance is reported as read back, not assumed", "read back, not assumed" in out)
s.stop()

# 6. Double-digit minor ordering. A lexical compare says v1.9.0 > v1.26.0; sort -V says otherwise,
#    and this repo is already past v1.26.0, so a lexical bug would silently refuse every advance.
s = Stub([val("v1.9.0"), val("v1.26.0")])
rc, out = run("v1.26.0", s)
check("v1.9.0 -> v1.26.0 is recognised as FORWARDS (version order, not lexical)",
      rc == 0 and len(s.patches()) == 1, "rc=%d patches=%d" % (rc, len(s.patches())))
s.stop()

# 7. The write is refused by the API.
s = Stub([val("v1.20.0")], patch_status=403)
rc, out = run("v1.26.0", s)
check("a refused PATCH FAILS loudly", rc == 1 and "failed (HTTP 403)" in out, "rc=%d out=%s" % (rc, out[-200:]))
s.stop()

# 8. 204 means accepted, never that the stored value is what you asked for.
s = Stub([val("v1.20.0"), val("v1.21.0")])
rc, out = run("v1.26.0", s)
check("a read-back that disagrees FAILS", rc == 1 and "read-back says STUDIO_RELEASE is v1.21.0" in out,
      "rc=%d out=%s" % (rc, out[-200:]))
s.stop()

print("")

# ---- --assert mode: the read-back that runs when NO WRITE HAPPENED -------------------------
#
# The cf#372 defect in one sentence: a skip and a success shared exit 0, so a release that never
# touched the pin was indistinguishable from one that advanced it. Failing closed on the absent
# credential fixes the case that actually bit us. This mode covers the rest of the class: it reads
# the pin and judges it against the tag REGARDLESS of what the advance step decided to do.
#
# The invariant is NOT pin == tag, it is pin NOT BEHIND tag. Re-running an older tag CI run is the
# sanctioned way to rebuild that artifact, and the advance correctly declines a backwards move on
# such a run; demanding equality would paint that red for doing the right thing. Trailing is the
# real defect, and assert is red exactly then.

s = Stub([val("v1.26.0")])
rc, out = run("v1.28.0", s, args=("--assert",))
check("assert is RED when the pin TRAILS the release", rc == 1, "rc=%d" % rc)
check("the trailing failure prints BOTH numbers, not a bare failure",
      "pin v1.26.0" in out and "release v1.28.0" in out)
check("assert sends ZERO patches", len(s.patches()) == 0, str(s.requests))
s.stop()

# CONTROL for the above: identical call shape, pin level. A mode that failed unconditionally would
# pass the trailing case and prove nothing.
s = Stub([val("v1.28.0")])
rc, out = run("v1.28.0", s, args=("--assert",))
check("CONTROL: assert is GREEN when the pin equals the release", rc == 0, "rc=%d out=%s" % (rc, out[-200:]))
check("the green assert states what it compared", "not behind release v1.28.0" in out)
s.stop()

# A pin AHEAD is the old-tag rebuild, and must stay green.
s = Stub([val("v1.28.0")])
rc, out = run("v1.27.0", s, args=("--assert",))
check("assert is GREEN when the pin is AHEAD (an older-tag rebuild)", rc == 0, "rc=%d" % rc)
s.stop()

# Version order, not lexical -- the same trap the advance path already guards.
s = Stub([val("v1.9.0")])
rc, out = run("v1.26.0", s, args=("--assert",))
check("assert reads v1.9.0 as BEHIND v1.26.0 (version order, not lexical)", rc == 1, "rc=%d" % rc)
s.stop()

# An unknown argument must not be silently ignored into advance mode.
s = Stub([val("v1.26.0")])
rc, out = run("v1.28.0", s, args=("--assrt",))
check("a MISTYPED mode is refused rather than falling back to advance",
      rc == 1 and "unknown argument" in out, "rc=%d" % rc)
check("the mistyped mode sends ZERO requests", len(s.requests) == 0, str(s.requests))
s.stop()

print("  " + str(checks - len(failures)) + " passed, " + str(len(failures)) + " failed")
sys.exit(1 if failures else 0)
