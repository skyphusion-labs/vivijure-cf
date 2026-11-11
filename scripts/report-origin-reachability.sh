#!/bin/sh
# report-origin-reachability.sh <rendered-wrangler.toml>
#
# Resolve every host that appears in a media-door value and REPORT. Never refuse. cf#886, ruled after
# cf#850 landed the config half.
#
# WHY THIS EXISTS. scripts/report-origin-vars.sh says BOUND or EMPTY per door var, which closed the
# silent-empty hole. It says nothing about whether a bound origin resolves, and the v1.34.3 deploy is
# the proof: it printed "7 media-door var(s): 7 bound, 0 empty" on a release where ELEVEN of the
# thirteen hostnames across those vars are authoritative NXDOMAIN. BOUND is a statement about the
# CONFIG. This is the cheapest available statement about the world.
#
# IT EXITS 0 ALWAYS, AND THAT IS LOAD-BEARING RATHER THAN LAZY.
#
# A release gate that depends on a third party being up is a gate that can block an unrelated release:
# a door being down has nothing to do with whether the change in front of it is safe to ship, and the
# first time it blocks someone at 2am it goes on the bypass list permanently. That is the same family
# as a jail that can ban your own ingress path -- a control whose failure mode is locking out
# legitimate work does not survive contact with a deadline. **If this script ever gains the power to
# refuse, it has become that gate with extra steps.** Ruled explicitly: report-only, no exceptions.
#
# `set -e` is deliberately ABSENT for the same reason. With it, any failing lookup or a resolver
# returning non-zero could terminate the script non-zero and quietly convert this into a blocking
# check. The contract is structural: its own file, no `set -e`, and `exit 0` at the end.
#
# BUT IT CANNOT BE SILENTLY ABSENT. An unmeasured run says so as a warning rather than printing
# nothing, because an absent report reads exactly like a clean one -- which is the failure family this
# whole sprint has been closing. "I could not ask" and "I asked and it is down" are different facts.
#
# THE BLIND SPOT IT KEEPS, named rather than papered over: a host that RESOLVES but is DEAD reads as
# fine here. DNS is not an availability check. cf#851 is the proof that this matters -- that door was a
# Durable Object binding with no hostname at all, so this script would have had nothing to say about
# it. cf#887 is the readiness surface that answers "is the tier serving NOW", and it is a different
# question with a different owner.
#
# HOSTNAMES ARE PRINTED, unlike the sibling var reporter which is names-only. These are non-secret repo
# variables, the runner's own env block already prints the full values in the same log, and a
# reachability report whose subject is hidden is useless.
set -u

toml="${1:-}"
if [ -z "$toml" ] || [ ! -f "$toml" ]; then
  echo "::warning::reachability: no rendered config at '${toml:-<unset>}', so reachability is UNMEASURED for this deploy."
  exit 0
fi

# Hosts from every media-door value. Values may be comma-separated lists (FINISH_*_DOORS), so split on
# commas, then strip scheme, then strip port and path. Deduped, because two vars often name one host.
hosts="$(
  grep -E '^[A-Z0-9_]+(_URL|_DOORS)[[:space:]]*=' "$toml" 2>/dev/null \
    | sed -E 's/^[^=]*=[[:space:]]*"?//; s/"[[:space:]]*$//' \
    | tr ',' '\n' \
    | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#[/:?].*$##' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -E '^[A-Za-z0-9._-]+$' \
    | sort -u
)"

if [ -z "$hosts" ]; then
  # A legitimate state, not a measurement failure: a render with every door empty has no host to check.
  # Said out loud so it is distinguishable from the script not having run.
  echo "reachability: 0 hosts in this config's media-door values (every door empty, or bindings only). Nothing to resolve."
  exit 0
fi

# RESOLVER, injectable so the control can drive both answers without a network round trip. It takes one
# hostname and exits 0 when it resolves. Default tries getent (glibc, present on the CI runner) then
# python3 (present on the runner and on a developer laptop, where getent does not exist).
resolve_one() {
  h="$1"
  if [ -n "${RESOLVER:-}" ]; then
    "$RESOLVER" "$h" >/dev/null 2>&1
    return $?
  fi
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$h" >/dev/null 2>&1
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket,sys; socket.getaddrinfo(sys.argv[1], None)' "$h" >/dev/null 2>&1
    return $?
  fi
  return 127
}

# Is there a resolver at all? Probe it on `localhost`, which resolves from /etc/hosts with no network,
# so a sandboxed or offline runner is distinguished from a broken one.
resolve_one localhost
probe=$?
if [ "$probe" -eq 127 ]; then
  echo "::warning::reachability: no resolver available (no getent, no python3, no \$RESOLVER), so reachability is UNMEASURED for this deploy. This is not a clean result."
  exit 0
fi
if [ "$probe" -ne 0 ]; then
  echo "::warning::reachability: the resolver could not resolve 'localhost', so it is not working and every result below would be meaningless. Reachability UNMEASURED."
  exit 0
fi

total=0
ok=0
bad=0
for h in $hosts; do
  total=$((total + 1))
  if resolve_one "$h"; then
    ok=$((ok + 1))
    echo "reachability: RESOLVES        ${h}"
  else
    bad=$((bad + 1))
    echo "::warning::reachability: DOES NOT RESOLVE ${h} -- a media door in this config names a host with no DNS answer, so that tier cannot be reached however the config reads. NOT failing the deploy on purpose (cf#886): a door being down is not a reason to block an unrelated release. See cf#887 for the readiness surface that answers whether a RESOLVING host is actually serving."
  fi
done

echo "reachability: ${total} host(s) in the media-door values: ${ok} resolve, ${bad} do not."
if [ "$bad" -gt 0 ]; then
  echo "reachability: ${bad} of ${total} media-door host(s) do not resolve. The deploy is NOT blocked (report-only, ruled). A BOUND var with an unresolvable host still reads as an installed tier to the studio."
fi
exit 0
