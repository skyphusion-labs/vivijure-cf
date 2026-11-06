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

saved = {k: os.environ.get(k) for k in (bearer.TOKEN_ENV, getattr(bearer, "ALLOW_UNAUTH_ENV", "_none"),
                                        getattr(bearer, "ACCEPT_MISSING_ENV", "_none2"))}


def set_env(token=None, allow=None, accept_missing=None):
    for k, v in ((bearer.TOKEN_ENV, token), (getattr(bearer, "ALLOW_UNAUTH_ENV", "_none"), allow),
                 (getattr(bearer, "ACCEPT_MISSING_ENV", "_none2"), accept_missing)):
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
        self.method = "POST"
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

    # cf#911 rollout stage. It relaxes exactly ONE case, an ABSENT header, and nothing else.
    set_env(token="s3cret", allow=None, accept_missing="true")
    check("STAGE: a media route with NO header is served", drive("/finish") == "SERVED")
    check("STAGE: a WRONG token is still refused 401", drive("/finish", "Bearer wrong") == 401)
    check("STAGE: a wrong SCHEME is still refused 401 (present is not absent)",
          drive("/finish", "s3cret") == 401)
    check("STAGE: the correct token is served", drive("/finish", "Bearer s3cret") == "SERVED")
    set_env(token="s3cret", allow=None, accept_missing="1")
    check("STAGE is exact-true only: '1' does not relax anything", drive("/finish") == 401)
    set_env(token=None, allow=None, accept_missing="true")
    check("STAGE without a token does not open the door: still 503", drive("/finish") == 503)
    set_env(token="s3cret", allow=None)

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

# ---------------------------------------------------------------- THE DEPLOYMENT
print("\n  DEPLOYMENT: every env FinishContainer can start the container with must satisfy the gate")

# cf#906 closed the seam between the gate and the deployment by CROSSING the language boundary:
# parse what src/finish-container.ts declares, then drive the actual Python gate with exactly those
# variables. cf#911 turned the one literal into two shapes, and BOTH are reachable in production:
#
#   token mode  FINISH_CONTAINER_TOKEN_VAR=<MEDIA_FINISH_TOKEN> plus FINISH_CONTAINER_STAGE_ENV
#   open mode   FINISH_CONTAINER_NO_TOKEN_ENV, when no token is readable, and before the first fetch
#
# A shape that does not start the container is a dead finish tier, so each is driven, each with a
# control that removes it.
FC = ROOT / "src" / "finish-container.ts"
fc_src = FC.read_text()


def ts_const_obj(name):
    m = re.search(r"export const " + name + r"\s*=\s*\{(.*?)\};", fc_src, re.S)
    if not m:
        return None
    return dict(re.findall(r'([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"', m.group(1)))


tm = re.search(r'export const FINISH_CONTAINER_TOKEN_VAR\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)";', fc_src)
token_var = tm.group(1) if tm else None
stage_env = ts_const_obj("FINISH_CONTAINER_STAGE_ENV")
open_env = ts_const_obj("FINISH_CONTAINER_NO_TOKEN_ENV")
print(f"    token var: {token_var}   stage env: {stage_env}   open env: {open_env}")
check("finish-container.ts declares the token var, and it is the one the gate reads",
      token_var is not None and token_var == bearer.TOKEN_ENV)
check("finish-container.ts declares the stage env as a literal", bool(stage_env))
check("finish-container.ts declares the no-token env as a literal", bool(open_env))
check("the class starts from the no-token env, so a start before the first fetch is not {}",
      re.search(r"envVars\s*:\s*Record<string,\s*string>\s*=\s*\{\s*\.\.\.FINISH_CONTAINER_NO_TOKEN_ENV\s*\}",
                fc_src) is not None)

AUTH_VARS = (bearer.TOKEN_ENV, bearer.ALLOW_UNAUTH_ENV, bearer.ACCEPT_MISSING_ENV)


def with_env(declared, fn):
    saved_dep = {k: os.environ.get(k) for k in AUTH_VARS}
    try:
        for k in AUTH_VARS:
            os.environ.pop(k, None)
        for k, v in declared.items():
            os.environ[k] = v
        return fn()
    finally:
        for k, v in saved_dep.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def starts():
    try:
        bearer.require_bearer_config()
        return "STARTS"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


token_env = {token_var or bearer.TOKEN_ENV: "deploy-token", **(stage_env or {})}
check("TOKEN MODE STARTS THE CONTAINER", with_env(token_env, starts) == "STARTS")
check("TOKEN MODE: no header is served (stage 1), and logged",
      with_env(token_env, lambda: drive("/finish")) == "SERVED")
check("TOKEN MODE: a WRONG token is refused 401",
      with_env(token_env, lambda: drive("/finish", "Bearer wrong")) == 401)
check("TOKEN MODE: the right token is served",
      with_env(token_env, lambda: drive("/finish", "Bearer deploy-token")) == "SERVED")
check("CONTROL: the stage env WITHOUT the token refuses to start (it is not an auth mode)",
      with_env(dict(stage_env or {}), starts) == "BearerConfigError")
check("OPEN MODE STARTS THE CONTAINER", with_env(dict(open_env or {}), starts) == "STARTS")
check("CONTROL: with no vars at all the container refuses to start",
      with_env({}, starts) == "BearerConfigError")

# The smoke gate has to run a DEPLOYMENT configuration, or it goes green on an image production
# cannot start, which it did (cf#906). It now supplies token mode, the shape a deploy with
# MEDIA_FINISH_TOKEN bound uses; the CI value is a throwaway and /health needs no credential.
ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
smoke_line = [l for l in ci.splitlines() if "container-smoke.sh" in l and "sh scripts/" in l]
check("the smoke gate invokes the smoke script exactly once", len(smoke_line) == 1)
if smoke_line:
    line = smoke_line[0]
    check("the smoke gate supplies every var of token mode",
          all(k + "=" in line for k in token_env))
    check("the smoke gate does NOT add the no-auth opt-out on top of a token",
          bearer.ALLOW_UNAUTH_ENV not in line)
smoke_sh = (ROOT / "scripts" / "container-smoke.sh").read_text()
check("container-smoke.sh forwards every var of token mode into the container",
      all(f"-e {k}=" in smoke_sh for k in token_env))

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
