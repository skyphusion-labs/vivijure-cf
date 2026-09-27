#!/bin/sh
# container-smoke.sh <image-ref> [container-port] [path] [timeout-seconds]
#
# Start a built container image and prove it SERVES. Exit 0 only when the port answers 2xx.
#
# WHY THIS EXISTS (cf#857, and it is an indictment of a gate this repo shipped the same night).
# `container-deploy-shape` runs `wrangler deploy --dry-run` WITH the container build and then proves
# an image was BUILT. `container-tests` runs the container's python test scripts against the REPO
# CHECKOUT. Neither one ever starts the image. So the single property anybody actually wants from a
# container gate -- does this thing boot and bind its port -- was unasserted, and a v1.34.1 tag run
# went green over an image that crashed on every startup (cf#851). Built and runs are two different
# properties and only the second is the product.
#
# THE TRAP THIS SCRIPT IS WRITTEN AGAINST: a smoke check whose cheapest satisfaction is skipping the
# container. Every unavailable instrument here is a FAILURE, never a skip -- no docker CLI, no
# daemon, an image that will not run, a container that exits, a port that never answers. A gate that
# can answer "could not measure" with exit 0 is the same defect one level up, which is the whole
# lesson of the issue that asked for this.
#
# NO ENV IS PASSED, deliberately. The deployed `[[containers]]` block in wrangler.toml.example sets
# no container env (its `[[secrets_store_secrets]]` entries are WORKER bindings, not container env),
# so a boot that depends on an env var must fail here exactly as it would in production. Passing a
# convenience env would make this gate more permissive than the real deploy, which is the fake-store
# mistake in a different costume.
#
# EXIT CODES are distinct so a control can assert WHICH failure happened, not merely that something
# did. A test that accepts any non-zero cannot tell a working guard from a broken one.
#   0  served
#   2  instrument unavailable (docker CLI missing, daemon unreachable, bad usage)
#   3  image would not run at all (docker run failed)
#   4  container EXITED before serving  <- the cf#851 shape
#   5  port never answered within the timeout (started, never bound)
#   6  answered, but not 2xx
set -eu

IMAGE="${1:?usage: container-smoke.sh <image-ref> [port] [path] [timeout-s]}"
PORT="${2:-8000}"
PATH_="${3:-/health}"
TIMEOUT="${4:-90}"

cid=""
cleanup() {
  if [ -n "$cid" ]; then
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

die() {
  code="$1"; shift
  echo "::error::container-smoke: $*"
  if [ -n "$cid" ]; then
    echo "--- docker inspect state"
    docker inspect --format '    status={{.State.Status}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} error={{.State.Error}}' "$cid" 2>&1 || true
    echo "--- container logs (last 60 lines) -- THIS is usually the whole answer"
    docker logs --tail 60 "$cid" 2>&1 | sed 's/^/    /' || true
  fi
  exit "$code"
}

command -v docker >/dev/null 2>&1 || { echo "::error::container-smoke: no docker CLI, so this gate cannot make its claim (not a skip)"; exit 2; }
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || { echo "::error::container-smoke: docker daemon unreachable, so this gate cannot make its claim (not a skip)"; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "::error::container-smoke: no curl, so this gate cannot probe the port (not a skip)"; exit 2; }

echo "container-smoke: starting ${IMAGE}, expecting ${PATH_} on container port ${PORT} within ${TIMEOUT}s"

# Bind to loopback only and let the daemon pick the host port, so concurrent jobs on one runner
# cannot collide on a fixed number.
cid="$(docker run -d --pull=never -p 127.0.0.1::"${PORT}" "${IMAGE}" 2>&1)" || {
  echo "--- docker run output"
  echo "${cid}" | sed 's/^/    /'
  cid=""
  die 3 "docker run failed, so the image is not even startable"
}

mapped="$(docker port "$cid" "${PORT}"/tcp 2>/dev/null | head -1 | sed 's/.*://')"
[ -n "${mapped:-}" ] || die 3 "the daemon published no host port for container port ${PORT} (does the image EXPOSE it?)"
url="http://127.0.0.1:${mapped}${PATH_}"
echo "container-smoke: container ${cid} mapped ${PORT} -> 127.0.0.1:${mapped}, probing ${url}"

i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  # AN EXITED CONTAINER IS ANSWERED IMMEDIATELY, not after the full timeout. The cf#851 failure is
  # detectable in milliseconds (the process dies at import), and burning 90 seconds to report it
  # would train the next reader to assume a red here means "slow", which is the wrong lesson.
  status="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  if [ "$status" != "running" ]; then
    die 4 "the container is '${status}' after ${i}s without ever serving ${PATH_}: it started and died rather than binding its port. This is the shape that shipped green in cf#851."
  fi

  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  case "$code" in
    2??)
      echo "container-smoke: OK -- ${PATH_} answered ${code} after ${i}s"
      echo "--- container logs (last 20 lines), for the record on a PASS too"
      docker logs --tail 20 "$cid" 2>&1 | sed 's/^/    /' || true
      exit 0
      ;;
    000) : ;;  # not listening yet; keep waiting
    *)
      # A 4xx/5xx means a process IS bound and answering, which is a different world from a crash.
      # Reported separately rather than folded into "did not answer".
      die 6 "${PATH_} answered HTTP ${code}, not 2xx. Something is bound and refusing, which is not the same failure as a crash."
      ;;
  esac
  i=$((i + 1))
  sleep 1
done

die 5 "${PATH_} never answered within ${TIMEOUT}s while the container stayed up: it is running but nothing is bound on ${PORT}."
