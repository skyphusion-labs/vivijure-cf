### BREAKING fix(containers): the bearer gate fails CLOSED, and every media container now has one (cf#893, GHSA-v8g8-gmcm-22gr)

**BREAKING FOR SELF-HOSTERS. A running deployment with no `LOCAL_FINISH_TOKEN` set will stop
starting.** That is the correct outcome and it is deliberate, not a side effect.

The one-line fix:

```bash
export LOCAL_FINISH_TOKEN="$(openssl rand -hex 32)"   # must match the store secret FINISH_DOOR_TOKEN
```

If a deployment is genuinely loopback-only and wants no authentication, ask for it **by name** with
`LOCAL_FINISH_ALLOW_UNAUTHENTICATED=true`. Unset is not a request for it. The insecure state is
choosable; it is never defaulted into.

**What was wrong.** `bearer_middleware` passed every request through when `LOCAL_FINISH_TOKEN` was
unset, and the docstring justified it: *"That is the current VPC path, which sends no credential.
Arming the token is a later flip."* Those doors moved onto public HTTPS three commits later the same
day, nothing re-armed the gate when the boundary moved, and the later flip never happened. A
fail-open default is defensible behind a private network boundary and is not defensible on a public
hostname, which is where a self-hoster following `compose.yaml` plus a tunnel ends up having never
been told a token existed.

**`image-prep` and `audio-master` had no gate at all**, only `url_guard.py`. Both now have one. Their
Dockerfiles were missing the `COPY` for it, caught by the cf#857 file-set guard, which is the same
defect class that crashed `video-finish` on startup earlier (`concat_guard.py` imported and never
copied).

**The next container inherits this rather than remembering it**, which is the actual fix for how two
containers ended up ungated:

- `tests/container-bearer-gate.test.py` **derives** the container list from which `app.py` builds a
  `web.Application`, so a new service cannot ship without a gate. A hardcoded list stays true while
  the population moves underneath it.
- It asserts all five vendor a **byte-identical** `bearer.py` and wire the middleware and the startup
  check.
- `compose.yaml` plumbs both env vars on the shared `x-common` anchor, so a new service inherits them
  from `*common`.

`GET /health` stays open with no credential, asserted explicitly at the wire, because swarm and
Traefik healthchecks depend on it: closing it would break orchestration instead of the auth hole. It
answers even when the container is misconfigured, so a bad deployment reports itself to its scheduler
rather than looking dead.

**Two layers, each meaningful.** `require_bearer_config()` runs at `__main__` and refuses to bind;
`bearer_middleware` independently answers **503** on every media route when no token is set, so a
future factory that forgets the startup call cannot silently reopen the gate.

**A stale test was passing for the wrong reason and is fixed here.** All three `test_bearer.py` files
asserted `r.status != 401` for an unset token under the label *"(fail-open)"*. That assertion **kept
passing** after the gate closed, because the new refusal is 503 and 503 is also `!= 401`. They now
assert the exact status. And **none of the three were in the CI list at all** -- two are now, which
is why the false claim survived unnoticed. `audio-beat-sync`'s is deliberately left out: it imports
`librosa`, and installing an audio-analysis stack to assert an HTTP status is a worse trade than the
structural coverage the repo-level test already gives it.

Also corrected: `wrangler.toml.example` claimed *"Unset is fail-open"* for `MEDIA_FINISH_TOKEN` while
`mediaDoorFetch` throws `MediaFinishAuthError` in exactly that case. Wrong in the SAFE direction,
which is still wrong: a reader trusting it reasons wrongly about the whole auth posture, and a
comment that under-claims a control is how the control gets "simplified" by someone who believes it
is not load-bearing.
