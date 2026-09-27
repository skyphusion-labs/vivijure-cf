### fix(finish): make every submit attempt attributable to the instance record it creates (cf#843)

`routingKey()` is minted per submit ATTEMPT, so every attempt addresses a fresh Durable Object and
creates a fresh container instance record. During `film-40e0cd09` the application's instance list grew
by one about every five minutes while assemble was stuck, and when those records were read back
**nothing could say which attempt created which**: the instances endpoint carries only
`{application_id, id, image, name, status}` (cf#844). cf#843 could not attribute `0706ec71...` to
either a second attempt or a first request landing late, and declined to guess. **This is the line that
makes the next occurrence answerable.**

Each submit now emits two structured lines, `{"ev":"finish.submit",...}`:

| phase | fields | when |
|---|---|---|
| `attempt` | `routing_key`, `path` | **before** the call |
| `outcome` | `routing_key`, `outcome`, `status`, `container_job_id` | after, one of `accepted` / `rejected` / `unparseable` / `malformed` / `threw` |

**The pre-call line is the load-bearing one.** The record is created by ADDRESSING the object, so if the
fetch throws or the isolate dies, the record exists and a post-hoc-only line would be exactly the
missing evidence again. A throwing submit logs `threw` and **rethrows unchanged**: core still reads it
as a failed submit and no behaviour is altered.

**6 of 10 is not a leak count, and this logging exists partly to stop that reading.** Measured
2026-09-27, six of the application's ten instance records carry 32-hex names. A SUCCESSFUL submit also
mints a key and creates a record, so the six are a mix of successes and orphans and there is no way to
split them retroactively. Attribution is the only thing that can, which is why it ships before any
change to how keys are minted.

**The line is a leak vector before it is an observability feature.** The submit payload carries
SigV4-presigned R2 URLs, and `tests/tenant-r2-forward.test.ts` exists because console output is how they
would escape. Fields are enumerated explicitly rather than spread, `init` and the body are never
touched, and the routing key is our own random hex identifying an instance rather than a credential.
Six guards in `tests/video-finish-binding-cf810.test.ts` cover it, appended there rather than in a new
file so the fake-namespace harness is not copied.

**Watched red, twice:**

- removing the pre-call `attempt` line fails **five** cases, including the leak guard, whose control
  asserts two lines were emitted so it cannot pass on silence;
- logging `init` instead of enumerated fields fails **exactly one**, the leak guard, and nothing else.

## What this does NOT do

**The deterministic per-job routing key is not in here, deliberately.** It is the other half of cf#843
and it interacts with `vivijure-core#308` (both assemble guards sit downstream of a successful submit,
so a submit that never succeeds is unbounded, OPEN, rollins). Whether a retry should reuse the same
object depends on whether a failed submit should be retried at all, and cf#843 says the two should be
decided together rather than separately. Changing the key scheme first would settle that question by
accident, in the wrong repo.

So cf#843 stays OPEN for the key change. What this closes is the reason it could not be investigated:
the next stuck film leaves a trail.
