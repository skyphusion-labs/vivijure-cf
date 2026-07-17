# hosted/ -- the hosted-tier front door assets

Static assets for the **platform control plane** worker (the hosted signup +
onboarding door at `studio.vivijure.com`). Vanilla JS/HTML/CSS, no framework, no
build step, like the rest of the studio frontend.

This is a SEPARATE asset bundle from `public/` on purpose: `public/` belongs to
the studio worker (and to every self-hoster), and the hosted signup flow has no
business shipping to a self-hosted studio.

| File | What it is |
|---|---|
| `public/onboarding.html` | The setup flow screens: what you get, the rules, the key, capacity, review, build, done. |
| `public/onboarding.js` | The flow: step machine, gates, and the control-plane API adapter. |
| `public/onboarding-checks.js` | Pure helpers (key shape, quota fit, cost ceiling, gates). Unit-tested in `tests/onboarding-checks.test.ts`. No DOM. |
| `public/onboarding-checks.d.ts` | Hand-authored types so the tests pass the `tsc` gate (no build step). |
| `public/platform.css` | Styles. Design tokens copied from `public/styles.css` (a separate worker cannot import it). |

## Wiring this up (integration notes)

**The API adapter in `onboarding.js` (`PlatformApi`) is PROVISIONAL.** The
control plane is Rollins' lane (#52 skeleton, #54 provisioner); these shapes are
a seam so the screens are drivable today, not a contract. When the real contract
lands, `PlatformApi` is the only place that changes: the screens render from the
data it returns and never hardcode what a plan contains.

Shapes currently assumed:

- `GET /api/hosted/plan` -> `{ endpoints: PlannedEndpoint[], cost_example }`
- `POST /api/hosted/capacity` `{ runpod_key }` -> `{ quota, existing_worker_sum }`
- `POST /api/hosted/provision` `{ runpod_key }` -> `{ job_id }`
- `GET /api/hosted/provision/:job_id` -> `{ status, studio_url, steps[] }`
- `GET /api/hosted/aup` -> `{ version, html }` (Ernst, #57)
- `POST /api/hosted/aup/accept` `{ version }` -> `{ ok }`

The worker serving these needs an assets binding pointing at `hosted/public`.

## Rules this code follows (do not regress them)

- **The key is never stored.** It lives in one closure variable, never in
  localStorage/sessionStorage, never in a URL, never logged, and is cleared once
  provisioning finishes. Live-verified, not just asserted.
- **Mock mode is an explicit opt-in** (`?mock=1`), never a fallback. A page that
  cannot reach its API must look broken, loudly. It must never quietly show a
  stranger invented quota numbers, invented costs, and a fake "your studio is
  live" link.
- **Every number shown is one we read back from RunPod.** Never the published
  balance table: it is stale (#60). If the real quota cannot be read, the flow
  refuses rather than guessing.
- **The plan is data, not UI.** Add an endpoint to the plan and the review screen
  grows a row on its own. The frontend is a projection.
- **The AUP block is a marked seam** (`AUP-PLACEHOLDER-START/END`), visible as a
  placeholder in the rendered page. Ernst owns that text (#57). Do not write
  policy prose there.

Public docs for the tier: [`docs/hosted-tier.md`](../docs/hosted-tier.md).
