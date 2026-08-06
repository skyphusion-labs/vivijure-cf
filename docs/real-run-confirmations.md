# Properties only a REAL RUN can confirm

Standing list for cf#278 phase 2. Source issue: [#369](https://github.com/skyphusion-labs/vivijure-cf/issues/369).

Things no unit test and no amount of review can settle -- properties that only a real artifact
moving through the real system will confirm. They used to appear one at a time in PR bodies, where
they were correctly stated and then structurally forgotten. **This file is the durable checklist.**
The GitHub issue remains the coordination thread for new entries and close-out observations; keep
the two in sync when an entry moves.

Each entry names what is unconfirmed, why a test cannot cover it, and what observation closes it.

## How to use this list

- **Add to it whenever a PR body says "confirm on the first real X".** That sentence is the trigger.
- Every entry needs a **POSITIVE observation**, never "nothing broke". Silent failure modes mean
  silence is the expected output of both the working and the broken state.
- An entry closes when someone records the actual observed value here (and on #369), with the job id
  or film id. Not when someone believes it works.
- **When a design change lands, re-read every open entry** and ask: "is the object it names still
  the one the property depends on?" An entry that names a specific artifact goes stale silently when
  that artifact stops being load-bearing (entry 1 below is the example).

Do **not** invent a GPU harness for these. Phase 2 is observation on real traffic, not a CI GPU lane.

---

## OPEN

### 1. What does `GET /status` return for a COMPLETED proxied job?

**Unconfirmed:** that a COMPLETED `/status` response carries `executionTime` and `delayTime` in the
shape `terminalFactsFromStatus` expects (control-plane RunPod proxy / billing ledger).

**Why no test covers it:** the 2a probe measured the FAILED **callback**, which is a different
artifact from the **`/status` response** for a successful job. CANCELLED is already known to omit
`executionTime`, so "probably the same" is the assumption measurement already contradicted once.

**History:** originally framed as "COMPLETED webhook payload shape". Superseded when the proxy made
the callback an untrusted **doorbell** -- the ledger reads only the credentialed `/status` fetch, not
the callback body. Logging the callback body would settle a question nothing consumes.

**What closes it:** the first real job the proxy handles that completes successfully. Log the raw
`/status` body once.

**Direction (not a substitute for the observation):** `terminalFactsFromStatus` writes nothing unless
the status parses to a terminal state, and an absent field stores NULL rather than 0. A surprising
COMPLETED envelope produces no write (row stays open), not a fabricated charge.

Refs: control-plane cp#288 / cp#291 / cp#293.

### 2. Does the RunPod callback fire at all on COMPLETED?

**Unconfirmed:** that RunPod delivers a terminal callback for a **successful** job.

**Why no test covers it:** all three 2a probe jobs terminated FAILED or CANCELLED. Observed: callback
fires on non-success terminals. Nobody has seen one fire on success.

**Why it matters:** if it does not fire on COMPLETED, every successful proxied job stays open until a
reconciler asks -- and a reconciler may not exist yet (`RECONCILER_ADOPT_AFTER_MS` was declared with
no consumer when this was filed). Silence is again the expected output of both states.

**What closes it:** one successful proxied job whose row reaches a terminal state without manual
intervention.

### 3. A red `migrations-gate` actually BLOCKS a merge

**Unconfirmed:** that a **failing** `migrations-gate` prevents a merge on this repo.

**Partially confirmed (2026-08-02, PR #370):** the check name matches and the rule is live. The first
PR under the required-check rule reported `migrations-gate` **SUCCESS** and was clean (not stuck on
"Expected -- waiting for status to be reported"). That rules out the misnamed-context failure mode
(which would block every merge while looking like slow CI).

**Still unconfirmed:** that a **RED** gate blocks the merge button.

**What closes it:** the first PR where a migration genuinely fails the gate and the merge button is
observed blocked. Or a deliberate test in a quiet window (not mid-sprint on a shared repo).

Refs: #358, #367, #370.

### 4. Proxy primitives have a real production caller (ledger path)

**Unconfirmed when filed:** that control-plane proxy code executes on a real submit (green suite over
unreachable code). Route wiring was a separate PR after the primitives.

**What closes it:** route wiring merged **and** one real submit transiting the proxy that reaches a
terminal state (same observation family as entries 1 and 2). Re-check against the live control-plane
before treating as still open; if a real COMPLETED proxied job has already been observed, close 1, 2,
and this together with evidence.

Refs: control-plane cp#290 / cp#291 / cp#293.

---

## CLOSED (positive observation recorded)

### C1. Measurement sidecar halves agree (key, shape, units) and reach `output_ms`

**Was:** container WRITES a sidecar the orchestrator can READ; sidecar before artifact; key agreement
via `metaKeyFor` / presign; written object becomes non-NULL `output_ms`.

**Why tests could not close it:** halves live in different repos and release cadences; python suite
does not observe PUT order; a broken fix and no fix both adopt to NULL.

**Closed 2026-08 (Mackaye), one-shot film on prod studio (v1.19.2 / core 1.7.2), single
`film.finish` step:**

| field | value |
| --- | --- |
| film id | `film-286df3e3-a636-45fa-b24b-5424e106bbb5` |
| render row | `ac27184f-4b7f-46bd-b4ec-c0bb43fdfb17` |
| film key | `renders/film-286df3e3-a636-45fa-b24b-5424e106bbb5/film-ff1.mp4` |
| container wrote (`film-ff1.meta.json`) | `{"duration_seconds": 8.875, "prepend_seconds": 3.0}` |
| orchestrator `output_ms` | `8875` (`8.875 * 1000`) |
| `film_finish.adopted` | `["film-titles"]` (exactly one step adopted) |

**Sign-off criterion used:** exactly ONE `film.finish` step, that step named in
`film_finish.adopted`, and `output_ms` non-NULL. Multi-step chains can satisfy a naive criterion
while the billed number came from a fold path; one-step removes the ambiguity.

Baseline immediately before the run: 0 of 50 most recent render rows had non-NULL `output_ms`.

Predictive control: title card requested at `title_seconds: 3`; sidecar returned `prepend_seconds: 3.0`.

Refs: core#130 / core#131, #370, #373, #663.

---

## Related (not this list)

- **RunPod public-endpoint slug existence** (minimax-hailuo, google-veo): free probe + rates in
  [`runpod-public-endpoint-slugs.md`](./runpod-public-endpoint-slugs.md). That is vendor-catalog
  confirmation, not a real-render property.
- **RunPod badge API 500** on Hub-manifest repos: vendor defect, documented in
  [`vendor-runpod-badge.md`](./vendor-runpod-badge.md).
- **Keyframe provenance when `project` is caller-supplied** (#388): code fix tracked on
  vivijure-core PR #151, not a phase-2 observation item.
