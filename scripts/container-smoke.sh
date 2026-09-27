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
# WHAT THIS GATE STRUCTURALLY CANNOT SEE, stated here rather than discovered during the next
# incident. A green from this script means "an image built from THIS SOURCE TREE boots and answers
# /health on an ubuntu-latest runner". It does not mean:
#
#   - THE DEPLOYED IMAGE SERVES. cf#851's crashing artifact was registry digest
#     sha256:324167ae95b8e025aba92726d7d2763e394215c3ff9ddcb9a574a57b69123124 in Cloudflare's managed
#     registry. This gate builds from the Dockerfile and runs with --pull=never, so it never touches
#     that digest and cannot be pointed at it without registry credentials and a pull. The two are
#     normally the same bytes; "normally" is not a gate. Compare the image id this prints against
#     what the deploy rolled out if that question ever matters.
#   - IT SERVES UNDER THE PLATFORM'S CONSTRAINTS. Cloudflare Containers runs instance_type
#     standard-4 with its own memory, disk and port-check timing. A runner has more of everything, so
#     an image that boots here can still be OOM-killed or time out there.
#   - ANY ROUTE BUT THE PROBED ONE WORKS. /health is a liveness probe, not a contract test. The
#     container's real surface (/async/finish, /inspect, /finish) is exercised by
#     containers/*/test_*.py against the source, not by this.
#
# The complement is deliberate and the boundary is the point: the static file-set guard
# (tests/container-image-file-set.test.py) catches the missing-COPY class before a build and names
# the file; this one catches anything that stops the process binding its port, whatever the cause.
# Neither substitutes for the other, and if either is ever read as standing in for the other we have
# rebuilt cf#857 in a new place.
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
    echo "--- the artifact this verdict is about"
    docker inspect --format '    image={{.Image}}' "$cid" 2>&1 || true
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
# cf#893: forward the bearer configuration into the container. The media containers now REFUSE TO
# START without LOCAL_FINISH_TOKEN, so smoking them unconfigured tests an unsupported deployment and
# reports exit 4 ("started and died") for a container that is behaving exactly as designed. Passed
# through from the ambient environment rather than invented here: a smoke test that mints its own
# credential is not smoking the thing operators run.
cid="$(docker run -d --pull=never \
  -e LOCAL_FINISH_TOKEN="${LOCAL_FINISH_TOKEN:-}" \
  -e LOCAL_FINISH_ALLOW_UNAUTHENTICATED="${LOCAL_FINISH_ALLOW_UNAUTHENTICATED:-}" \
  -p 127.0.0.1::"${PORT}" "${IMAGE}" 2>&1)" || {
  echo "--- docker run output"
  echo "${cid}" | sed 's/^/    /'
  cid=""
  die 3 "docker run failed, so the image is not even startable"
}

mapped="$(docker port "$cid" "${PORT}"/tcp 2>/dev/null | head -1 | sed 's/.*://')"
# NOT "did you EXPOSE it?": `-p` publishes regardless of EXPOSE, so an empty mapping here means the
# daemon reported no binding for the port at all, which is a daemon or argument problem rather than a
# Dockerfile one. Blaming EXPOSE would send the next reader to a line that is not the cause.
[ -n "${mapped:-}" ] || die 3 "the daemon published no host port for container port ${PORT} (docker port returned nothing; this is not an EXPOSE problem, -p publishes without it)"
url="http://127.0.0.1:${mapped}${PATH_}"
echo "container-smoke: container ${cid} mapped ${PORT} -> 127.0.0.1:${mapped}, probing ${url}"

# CITE THE ARTIFACT, NOT THE NAME. A tag is mutable and says nothing about which bytes ran, so a
# report that quotes only "video-finish:ci" cannot be checked later and cannot distinguish a broken
# image from its fix. The id is read off the CONTAINER (`.Image`), i.e. the image this run actually
# used, rather than by resolving the tag a second time. RepoDigests exists only for an image that has
# been pushed or pulled: a locally built one legitimately has none, and saying so is better than
# printing an empty field that reads like a missing value.
image_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || echo unknown)"
repo_digests="$(docker image inspect --format '{{if .RepoDigests}}{{join .RepoDigests ","}}{{else}}(none: locally built, never pushed){{end}}' "$IMAGE" 2>/dev/null || echo unknown)"
echo "container-smoke: image id ${image_id}"
echo "container-smoke: repo digests ${repo_digests}"

# ELAPSED WALL TIME, not an attempt count. The first version counted iterations and reported "within
# ${TIMEOUT}s", but each iteration can burn the curl -m 5 budget plus a sleep, so the message was
# claiming a bound the loop did not enforce. Same family as every comment this sprint that asserted a
# property its code did not hold; it is not more forgivable in my own file.
started="$(date +%s)"
i=0
while [ "$(( $(date +%s) - started ))" -lt "$TIMEOUT" ]; do
  i=$(( $(date +%s) - started ))
  # AN EXITED CONTAINER IS ANSWERED IMMEDIATELY, not after the full timeout. The cf#851 failure is
  # detectable in milliseconds (the process dies at import), and burning 90 seconds to report it
  # would train the next reader to assume a red here means "slow", which is the wrong lesson.
  status="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  if [ "$status" != "running" ]; then
    die 4 "the container is '${status}' after ${i}s without ever serving ${PATH_}: it started and died rather than binding its port. This is the shape that shipped green in cf#851."
  fi

  # NOT `$(curl ... || echo 000)`: on a connection failure curl ALREADY prints its own
  # %{http_code} of "000" and then exits non-zero, so the fallback inside the substitution
  # CONCATENATED onto it and produced "000000". That fell through to the not-2xx arm and reported
  # "something is bound and refusing" about a container that had simply not finished starting. The
  # fixture control in tests/container-smoke.test.sh caught it on the first CI run, before this
  # script had ever judged a real image. The fallback belongs OUTSIDE the substitution, and anything
  # that is not exactly three digits is normalised rather than trusted.
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url" 2>/dev/null)" || code=""
  case "$code" in
    [0-9][0-9][0-9]) : ;;
    *) code="000" ;;
  esac
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
  sleep 1
done

die 5 "${PATH_} never answered within ${TIMEOUT}s (measured on the clock, $(( $(date +%s) - started ))s elapsed) while the container stayed up: it is running but nothing is bound on ${PORT}."
