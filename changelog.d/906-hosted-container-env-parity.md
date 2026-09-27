### fix(containers): give the hosted container the bearer config cf#893 requires, and make the smoke gate able to see it (cf#906)

cf#893 made the media containers refuse to start without a bearer configuration. **Nothing gave the
Cloudflare-hosted `FinishContainer` one**, so the next deploy would have killed the hosted finish
tier: the container exits at `require_bearer_config()` before binding, and the platform reports
`Container crashed while checking for ports` -- the same shape a missing `COPY` produced earlier.

Measured rather than inferred. `envVars` defaults to `{}` in `@cloudflare/containers`, the
`[[containers]]` block carries no env, the Dockerfile sets none, and `src/` had zero `envVars` hits.
Running the container's real entry point with that environment exits **1**; with the variable below
it binds and serves.

**The opt-out rather than a token, and the reason removes the choice rather than weighing it.**
`mediaDoorFetch` takes the bound branch first (`if (bound) return bound.fetch(...)`) and returns
**before** the token lookup, so the binding path never attaches an `Authorization` header -- as
`src/video-finish-binding.ts:15` says in its own words: *"the door is the BINDING. No hostname, no
DNS, no edge hop, no bearer required."* A token on the container turns every Worker call into 401.

And it is right on the merits: GHSA-v8g8 found a fail-open default defensible behind a private
network boundary and indefensible on a public hostname. **The `[[containers]]` binding IS that
private boundary.** This is the one deployment where the old docstring was telling the truth, so the
insecure-looking state is now **CHOSEN there by name, with the argument at the site**, instead of
being the silent default everywhere including the public hostnames the advisory was about.

**The smoke gate could not see any of this, and that is the more important half.**
`container-smoke` injected `LOCAL_FINISH_TOKEN=ci-smoke-token`, which **production has no way to
set**, so it went green on an image the hosted tier cannot start. That is cf#857's own defect class
reappearing *inside the gate built to close it*. It now supplies what the deployment supplies.

**The seam is closed by a test that crosses the language boundary**, because the two halves were
each correct and nobody ran one against the other: `tests/container-bearer-gate.test.py` parses the
`envVars` that `src/finish-container.ts` declares and drives the real Python `require_bearer_config`
with exactly those variables. A TypeScript test could assert the property exists; only this asserts
it **satisfies the gate**. It also pins that the smoke gate does not inject a token and does supply
the declared var.

Watched red on both halves: removing `envVars` fails 3 checks, and restoring the injected token in
the smoke gate fails 2.

Authenticating the binding hop itself is a real improvement and a contract change on core's bound
path. Tracked separately; GHSA-v8g8 is closed by this, not by that.
