"""cf#893 / GHSA-v8g8-gmcm-22gr: the container bearer gate must fail CLOSED.

`bearer_middleware` passed every request through when `LOCAL_FINISH_TOKEN` was unset, and the
docstring justified it with a private Workers VPC that stopped existing three commits later the same
day. A fail-open default is defensible behind a private network boundary; it is not defensible on a
public hostname, which is where a self-hoster following `compose.yaml` plus a tunnel ends up.

This file covers BOTH halves, and the second is the one that keeps it true:

  BEHAVIOUR  -- unset token refuses to start; /health stays open; a correct bearer passes and a
                wrong one is refused; the no-auth mode exists but must be asked for by name.
  STRUCTURE  -- every container that serves HTTP vendors the SAME bearer.py and wires it into its
                Application. `image-prep` and `audio-master` had no gate at all because three
                vendored copies drifted and nobody was counting, so the next container must INHERIT
                the requirement rather than remember it.

Run:  python3 tests/container-bearer-gate.test.py
Exits non-zero on any failed assertion.
"""
import hashlib
import importlib.util
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTAINERS = ROOT / "containers"
REFERENCE = "video-finish"  # the copy the others are vendored from

failures = []


def check(label, cond):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}")
    if not cond:
        failures.append(label)


def load_bearer(container):
    """Import a container's own bearer.py under a unique module name."""
    path = CONTAINERS / container / "bearer.py"
    spec = importlib.util.spec_from_file_location(f"bearer_{container.replace('-', '_')}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def http_containers():
    """Every container whose app.py builds an aiohttp Application.

    Derived rather than listed. A hardcoded list is exactly how a new container ships without a
    gate: the list stays true and the population moves underneath it.
    """
    out = []
    for d in sorted(CONTAINERS.iterdir()):
        app = d / "app.py"
        if app.is_file() and "web.Application" in app.read_text():
            out.append(d.name)
    return out


print("cf#893 container bearer gate")
serving = http_containers()
print(f"\n  containers serving HTTP (derived from app.py): {len(serving)} -> {', '.join(serving)}")
check("the derivation found containers at all (a zero here would pass everything below)",
      len(serving) >= 3)

# ---------------------------------------------------------------- STRUCTURE
print("\n  STRUCTURE: the next container inherits the gate rather than remembering it")
ref_digest = hashlib.sha256((CONTAINERS / REFERENCE / "bearer.py").read_bytes()).hexdigest()
for c in serving:
    p = CONTAINERS / c / "bearer.py"
    check(f"{c} vendors bearer.py", p.is_file())
    if p.is_file():
        check(f"{c} bearer.py is byte-identical to {REFERENCE}",
              hashlib.sha256(p.read_bytes()).hexdigest() == ref_digest)
    app_src = (CONTAINERS / c / "app.py").read_text()
    check(f"{c} wires bearer_middleware into its Application",
          re.search(r"middlewares\s*=\s*\[[^\]]*bearer_middleware", app_src, re.S) is not None)
    check(f"{c} calls the startup config check",
          "require_bearer_config" in app_src)

# ---------------------------------------------------------------- BEHAVIOUR
print("\n  BEHAVIOUR: fail closed, measured against the reference copy")
bearer = load_bearer(REFERENCE)

saved = {k: os.environ.get(k) for k in (bearer.TOKEN_ENV, getattr(bearer, "ALLOW_UNAUTH_ENV", "_none"))}


def set_env(token=None, allow=None):
    for k, v in ((bearer.TOKEN_ENV, token), (getattr(bearer, "ALLOW_UNAUTH_ENV", "_none"), allow)):
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


try:
    # THE DEFECT: no token, no explicit opt-out -> the door must REFUSE TO START.
    set_env(token=None, allow=None)
    try:
        bearer.require_bearer_config()
        check("unset token REFUSES to start", False)
    except Exception as e:  # noqa: BLE001
        check("unset token REFUSES to start", type(e).__name__ == "BearerConfigError")
        check("the refusal names the env var to set",
              type(e).__name__ == "BearerConfigError" and bearer.TOKEN_ENV in str(e))
        check("the refusal names the explicit no-auth opt-out",
              type(e).__name__ == "BearerConfigError"
              and getattr(bearer, "ALLOW_UNAUTH_ENV", "\x00") in str(e))

    # An empty string is not a token. This is the shape that would sneak past a truthiness check
    # written as `is not None`.
    set_env(token="   ", allow=None)
    try:
        bearer.require_bearer_config()
        check("a whitespace-only token is REFUSED, not accepted as configured", False)
    except Exception as e:  # noqa: BLE001
        check("a whitespace-only token is REFUSED, not accepted as configured",
              type(e).__name__ == "BearerConfigError")

    # POSITIVE CONTROL: a configured token must let the door start, or this gate is unshippable.
    set_env(token="s3cret", allow=None)
    try:
        bearer.require_bearer_config()
        check("POSITIVE CONTROL: a configured token starts normally", True)
    except Exception as e:  # noqa: BLE001
        check(f"POSITIVE CONTROL: a configured token starts normally ({e})", False)

    # The insecure state must be CHOSEN by name, never defaulted into.
    set_env(token=None, allow="true")
    try:
        bearer.require_bearer_config()
        check("an EXPLICIT no-auth opt-out is honoured", True)
    except Exception as e:  # noqa: BLE001
        check(f"an EXPLICIT no-auth opt-out is honoured ({e})", False)

    set_env(token=None, allow="false")
    try:
        bearer.require_bearer_config()
        check("the opt-out is NOT the default: 'false' still refuses", False)
    except Exception as e:  # noqa: BLE001
        check("the opt-out is NOT the default: 'false' still refuses",
              type(e).__name__ == "BearerConfigError")
finally:
    pass

# ---------------------------------------------------------------- THE WIRE
print("\n  WIRE: what the middleware actually does to a request")


class FakeReq:
    """Minimal stand-in: bearer_middleware reads only .path and .headers."""

    def __init__(self, path, auth=None):
        self.path = path
        self.headers = {"Authorization": auth} if auth else {}


async def _ok_handler(_req):
    return "SERVED"


def drive(path, auth=None):
    """Run the middleware and report either the handler's result or the refusal status."""
    import asyncio

    res = asyncio.run(bearer.bearer_middleware(FakeReq(path, auth), _ok_handler))
    return res if isinstance(res, str) else getattr(res, "status", None)


try:
    set_env(token="s3cret", allow=None)

    # THE CONTROL THAT IS EASY TO OMIT because it does not feel like the subject. Swarm and Traefik
    # healthchecks call /health with no credential. If fail-closed takes this route with it, the
    # change breaks orchestration instead of the auth hole, and the container looks dead to its
    # scheduler rather than protected.
    check("POSITIVE CONTROL: GET /health passes with NO credential while the gate is armed",
          drive("/health") == "SERVED")
    check("...and /health/ with a trailing slash too", drive("/health/") == "SERVED")

    check("a media route with NO credential is refused 401", drive("/finish") == 401)
    check("a media route with the WRONG credential is refused 401",
          drive("/finish", "Bearer wrong") == 401)
    check("POSITIVE CONTROL: the CORRECT credential is served",
          drive("/finish", "Bearer s3cret") == "SERVED")
    check("the scheme is checked, not just the value",
          drive("/finish", "s3cret") == 401)

    # Second line of defense: if a future app factory forgets require_bearer_config, the middleware
    # must still refuse rather than reopening the gate. This is the exact state cf#893 closed.
    set_env(token=None, allow=None)
    check("with NO token and no opt-out, a media route is 503 -- never served",
          drive("/finish") == 503)
    check("...and /health STILL answers, so a misconfigured door reports itself to its scheduler",
          drive("/health") == "SERVED")

    # And the explicit opt-out really does open it, or the escape hatch is a lie.
    set_env(token=None, allow="true")
    check("with the explicit opt-out, a media route is served", drive("/finish") == "SERVED")
finally:
    pass

for _k, _v in saved.items():
    if _v is None:
        os.environ.pop(_k, None)
    else:
        os.environ[_k] = _v

print()
if failures:
    print(f"FAILED: {len(failures)}")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
