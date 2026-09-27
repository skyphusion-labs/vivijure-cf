### ci(deploy): report which media-door hosts do not resolve, and never refuse a release for it (cf#886)

cf#850 landed the config half: `BOUND` or `EMPTY` per media-door var, with one contradiction refused.
**It says nothing about whether a bound origin resolves**, and the `v1.34.3` deploy is the proof. Its
log reads:

```
origin-vars: 7 media-door var(s) in wrangler.toml: 7 bound, 0 empty.
origin-vars: [[containers]] is bound and VIDEO_FINISH_URL is non-empty, so the finish tier reads as installed.
```

Rendered from the committed template with the live repo-variable values, the new report beside it reads:

```
reachability: 10 host(s) in the media-door values: 0 resolve, 10 do not.
```

**Zero of ten.** `BOUND` is a statement about the CONFIG; this is the cheapest available statement about
the world. About seven lookups in practice, sub-second, no egress, no credential.

**Correcting my own denominator while I am here:** I previously reported "11 of 13 hostnames NXDOMAIN".
That 13 counted a non-door hostname I probed by mistake (`studio-mcp.skyphusion.org`, where the live var
is `studio-mcp.vivijure.com`). Measured properly: **all 12 door hostnames across the 8 origin-bearing
repo variables are NXDOMAIN**, and **10 of those reach the rendered config** (`SPEECH_UPSCALE_DOORS`
has no consumer in the template since the module was excised), all 10 unresolvable.

## Report-only is the contract, and it is structural rather than promised

An HTTP probe in the deploy gate was refused on posture and this inherits the reasoning: **a release
gate that depends on a third party being up is a gate that can block an unrelated release.** A door
being down has nothing to do with whether the change in front of it is safe to ship, and the first time
it blocks someone at 2am it goes on the bypass list permanently -- the same family as a jail that can
ban your own ingress path. An HTTP probe would also need `MEDIA_FINISH_TOKEN`, putting a credential in a
path that needs none.

So the never-refuse property lives in the artifact, not in a comment promising good behaviour: its own
file, **no `set -e`**, `exit 0` as the last line, and invoked BARE in `ci.yml` with no `||`, no `&&` and
no `exit`. `tests/origin-reachability-cf886.test.ts` asserts every one of those, including the script's
own text, because **if this ever gains the power to refuse it has become the gate that was refused.**

**Not taken on trust, two mutations, both caught, both restored:**

- make it exit non-zero when a host is dead -> the two "still exits 0" cases fail;
- add `set -e` -> **three** cases fail, including both UNMEASURED paths. That second result is the
  interesting one: `set -e` does not merely risk refusal in theory, it actually converts an
  unmeasurable run into a non-zero exit, because a resolver returning non-zero terminates the script.
  The absence of `set -e` is load-bearing, not stylistic.

## An unmeasured run says so, because absence reads exactly like cleanliness

- No resolver at all (no `getent`, no `python3`, no injected `$RESOLVER`) -> a warning saying
  UNMEASURED and explicitly "this is not a clean result", and it does **not** go on to print per-host
  verdicts it could not have obtained.
- A resolver that fails on everything -> caught by a `localhost` probe first, so a broken tool reads as
  a broken tool rather than as a catastrophic ten-host outage.
- Every door empty -> "0 hosts ... nothing to resolve", said out loud rather than printed as silence.
- A missing rendered config -> UNMEASURED, exit 0.

## The blind spot, named

**A host that RESOLVES but is DEAD reads as fine here.** DNS is not an availability check, and cf#851
is the proof that this matters: that door was a Durable Object binding with no hostname at all, so this
script would have had nothing to say during those six hours. cf#887 is the readiness surface that
answers "is the tier SERVING now", filed rather than built, and it records why it does not reopen
`core#327`'s ruling that the RENDER PATH reads the submit outcome and never a predicate.

No network in the tests: `localhost` resolves from `/etc/hosts` and `*.invalid` is reserved by RFC 2606
and never resolves, so both answers are deterministic offline. The resolver is injectable so the
instrument-failure paths are driven without touching the machine's DNS, and a stub that resolves
everything is the positive control on the injection seam itself.
