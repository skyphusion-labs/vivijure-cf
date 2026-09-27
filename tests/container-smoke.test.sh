#!/bin/sh
# container-smoke.test.sh -- the control on scripts/container-smoke.sh (cf#857).
#
# cf#857 is about a gate that COULD NOT FAIL, so a smoke step arriving without its own planted
# failure would be the same defect one rung up. This file is that control, and it asserts BOTH
# directions on the same instrument:
#
#   serves            -> exit 0   the POSITIVE control. Without this the gate might always fail,
#                                 and "it went red on the broken image" would prove nothing.
#   crash-on-import   -> exit 4   the cf#851 shape, planted: a top-level import of a module that is
#                                 not in the image, so the process dies before binding.
#   binds-wrong-port  -> exit 5   started, stayed up, never answered on the port under test.
#   image-not-present -> exit 3   an instrument failure is a FAILURE, never a skip.
#
# EXIT CODES ARE ASSERTED EXACTLY, not merely "non-zero". A check that accepts any failure cannot
# tell a working guard from one that is broken in a new way, and this whole issue is about a green
# that meant less than it looked like.
#
# Fixtures are built HERE rather than committed as a directory, so the planted failure sits in the
# same file as the assertion about it. Each is a two-line delta from the passing one: that is the
# point, because the defect being guarded against was also a one-line delta.
#
# Run: sh tests/container-smoke.test.sh   (needs docker; exits 2 if it cannot measure)
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SMOKE="${ROOT}/scripts/container-smoke.sh"
[ -f "$SMOKE" ] || { echo "::error::missing ${SMOKE}: a wrong cwd must fail loudly, not match nothing and pass"; exit 1; }

command -v docker >/dev/null 2>&1 || { echo "::error::no docker CLI: this control cannot make its claim (not a skip)"; exit 2; }
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || { echo "::error::docker daemon unreachable: this control cannot make its claim (not a skip)"; exit 2; }

WORK="$(mktemp -d)"
TAGS=""
cleanup() {
  for t in $TAGS; do docker rmi -f "$t" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

ran=0
failed=0

check() {
  name="$1"; want="$2"; want_text="$3"; image="$4"
  ran=$((ran + 1))
  out="$(sh "$SMOKE" "$image" 8000 /health 20 2>&1)" && got=0 || got=$?
  ok=1
  [ "$got" = "$want" ] || ok=0
  if [ -n "$want_text" ]; then
    printf '%s' "$out" | grep -q "$want_text" || ok=0
  fi
  if [ "$ok" = "1" ]; then
    printf '  ok    %-18s exit %s%s\n' "$name" "$got" "$([ -n "$want_text" ] && printf ' (reason matched)')"
  else
    failed=$((failed + 1))
    printf '  FAIL  %-18s wanted exit %s' "$name" "$want"
    [ -n "$want_text" ] && printf ' with /%s/' "$want_text"
    printf ', got exit %s\n' "$got"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}

# ------------------------------------------------------------------ the serving fixture
mkdir -p "$WORK/serves"
cat > "$WORK/serves/serve.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import os, sys
PORT = int(os.environ.get("BIND_PORT", "8000"))
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ok":true}'
        code = 200 if self.path == "/health" else 404
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
print("fixture listening on %d" % PORT, flush=True)
HTTPServer(("0.0.0.0", PORT), H).serve_forever()
PY
cat > "$WORK/serves/Dockerfile" <<'DF'
FROM python:3.11-slim-bookworm
WORKDIR /app
COPY serve.py .
EXPOSE 8000
CMD ["python", "serve.py"]
DF

# ------------------------------------------------------------------ the cf#851 fixture, planted
# A top-level import of a module the image does not contain. Byte-for-byte the failure mode of
# containers/video-finish (app.py imports concat_guard at column 0; the Dockerfile COPY line omits
# it), reproduced without touching that directory.
mkdir -p "$WORK/crash"
{ echo "from not_copied_into_the_image import assert_no_dropped_parts"; cat "$WORK/serves/serve.py"; } > "$WORK/crash/serve.py"
cp "$WORK/serves/Dockerfile" "$WORK/crash/Dockerfile"

# ------------------------------------------------------------------ the wrong-port fixture, planted
# Starts, stays up, binds a port nothing probes. Distinguishes "never bound where we look" from
# "died", which is why the two get different exit codes.
mkdir -p "$WORK/wrongport"
cp "$WORK/serves/serve.py" "$WORK/wrongport/serve.py"
sed 's/^EXPOSE 8000$/EXPOSE 8000\nENV BIND_PORT=9999/' "$WORK/serves/Dockerfile" > "$WORK/wrongport/Dockerfile"
grep -q 'BIND_PORT=9999' "$WORK/wrongport/Dockerfile" || { echo "::error::fixture edit did not land: the wrong-port case would silently become a duplicate of the serving case"; exit 1; }

echo "building three fixtures (one serving, two planted failures)"
for f in serves crash wrongport; do
  tag="vivijure-cf857-fixture-${f}:test"
  TAGS="${TAGS} ${tag}"
  docker build -q -t "$tag" "$WORK/$f" >/dev/null || { echo "::error::fixture build failed for ${f}: the control cannot run"; exit 2; }
done

echo "asserting the smoke script's verdict on each:"
check serves           0 "OK -- /health answered 2"          vivijure-cf857-fixture-serves:test
check crash-on-import  4 "started and died rather than"      vivijure-cf857-fixture-crash:test
check binds-wrong-port 5 "nothing is bound on 8000"          vivijure-cf857-fixture-wrongport:test
check image-not-present 3 "not even startable"               vivijure-cf857-no-such-image-exists:test

# The floor. A control loop that runs zero cases exits 0 and is indistinguishable from four passes,
# which is the exact failure family cf#857 was filed about.
echo "ran ${ran} cases, ${failed} failed"
[ "$ran" -eq 4 ] || { echo "::error::expected 4 control cases, ran ${ran}"; exit 1; }
[ "$failed" -eq 0 ] || { echo "::error::${failed} control case(s) failed: scripts/container-smoke.sh does not behave as claimed, so any green it reports on a real image is worthless"; exit 1; }
echo "control OK: the smoke script passes a serving image and fails BOTH planted failures with distinct, asserted reasons."
