# Studio MCP parity: what an agent can reach, and what it can SEE

**Measured, not asserted.** Every number here is derived at test time by
`tests/mcp-parity-317.test.ts` from two artifacts: the studio route table in `src/index.ts`, and the
tool catalog of the **installed** `@skyphusion-labs/vivijure-mcp` package (the same code the deployed
MCP Worker runs). The test asserts these numbers, so adding a route or a tool fails CI until this
document is re-measured. Tracking issue: cf#317.

The reason this document leads with its denominator is cf#295: a surface that reports on a subset
without saying so is the defect, not the subset.

## The populations (get these confused and the conclusion inverts)

| Population | Count | What it is |
|---|---|---|
| Studio API route entries | **87** | Distinct `method` + `pattern` pairs the studio serves, ALL of them in `API_ROUTES`. Until cf#520, 85 were in the table and `GET /api/modules` was dispatched inline before it, so every consumer of this number had to compensate by hand; the route was moved into the table and the compensations deleted. cf#353 then added `POST /api/storyboard/renders/:id/retry`. |
| Panel-reachable | **67** | Route entries the panel calls WITH THAT METHOD, i.e. the human surface. Derived at test time from the panel's own `fetch`/`api` call sites and `.href`/`.src` DOM assignments (cf#333), with controls in both directions. Can be too LOW: a call built through more than one hop of variable indirection, or through a call shape outside those two, is invisible to it. |
| MCP tools | **42** | 41 curated tools plus the `studio_request` escape hatch. |
| Reached by a CURATED tool | **41** | Route entries with a purpose-built tool. |
| Reachable via `studio_request` | **84** | Every route EXCEPT the three that read a raw request body. The hatch sends `application/json` and those refuse it on the content-type. |
| Byte-returning, invisible on the way OUT | **4** | Route entries whose response is BYTES. |
| Raw-body, unreachable through the HATCH | **3** | The bytes-IN class. 2 of the 3 now have curated tools (`upload_image`, `upload_audio`); `POST /api/storyboard/character-ref` does not, and needs none (see below). |

Two of those rows are the whole finding, and they point in opposite directions from what the issue
assumed.

## Finding 1: action parity is MOSTLY not the gap, and the exception was invisible

`studio_request` sends any method to any path with the studio bearer, so for **84 of 87** route
entries there is nothing an agent cannot invoke. Curated coverage is 41 of 87 (48%), and that number
measures **ergonomics**, not capability: a curated tool means the agent does not have to know the
contract to find the route. For those 84 a low number costs discoverability, not reach, and 46
routes require the agent to read `docs/CONTRACT.md` first.

### The correction, and it was this document's own claim

**An earlier revision of this section said "There is no route in the contract an agent cannot
invoke." That was false for three routes**, and the error is mine. `POST /api/upload`,
`POST /api/storyboard/audio-upload` and `POST /api/storyboard/character-ref` read a **raw request
body** and dispatch on the content-type header. `studio_request` sends `application/json`. Those
routes answer `400` on the content-type before reading anything, so the hatch could name them and
never satisfy them.

The cause is worth more than the instance: **route REACH was measured and body ENCODING never was.**
A route the hatch could address counted as covered regardless of whether it could be satisfied. Two
of the three now have curated tools (`upload_image`, `upload_audio`, `vivijure-mcp` v1.2.0) and the
gap is asserted by a test that drives the shipped `studio_request` at `/api/upload` and checks the
content-type it sends, so the finding cannot quietly outlive its own truth.

Note the direction, which is why nothing surfaced it: the error made the surface look **more**
reachable than it was.

Note also the asymmetry the table makes visible: parity is not a subset relation in either direction.
`POST /api/render/film` and `GET /api/render/film/:id` -- the film submit and poll the MCP is built
around -- are **not panel-reachable at all**. The panel renders through `/api/storyboard/render`.
The agent surface and the human surface overlap; neither contains the other. Reconciling those doors
is vivijure-cf#334, and it is why no curated tool aims at a render submit, poll or cancel route.

## Finding 2: artifact parity WAS zero, and that was the real gap (now closed)

**Status: closed by `vivijure-mcp` v1.1.0 plus this repo's dependency bump to `^1.1.0`.** The
measurement below is preserved as written, because it is the evidence that motivated the fix and a
finding deleted the moment it is fixed leaves the next reader unable to tell it ever existed. What
changed: `view_artifact` returns an image as MCP image content, and `artifact_url` returns a
short-lived presigned link for what MCP structurally cannot carry. `HEAD /api/artifact/*key` and
the two `/api/cast/export/:id` entries remain byte-returning with no curated tool, so the
**structurally invisible** row is unchanged at 4: this closed the agent-can-SEE gap, not the whole
byte-returning class.

Every route whose response is bytes is invisible through the MCP. `runTool` detects a binary
content-type and returns a text summary instead of the object:

```
GET /api/artifact/renders/film-80c356bf.../film.mp4 -> 200

Binary response (video/mp4, 3811331 bytes) not inlined.
```

That is a real, live response from the production MCP against a real finished film. The four
byte-returning route entries are `GET` + `HEAD /api/artifact/*key` and `GET` + `POST
/api/cast/export/:id`.

The consequence is the thing Conrad named: an agent can plan a film, cast it, submit it, watch it
complete, and then **cannot look at what it made**. Neither can it look at a keyframe, a portrait,
a generated still, or a per-shot clip. The refusal is ours, not the protocol's -- MCP carries images
natively; we were summarizing them.

### One correction to the premise

The issue states that "nothing in the surface hands back a fetchable or viewable film." That is
**not accurate**, and it was worth checking rather than inheriting. `poll_film` already returns a
presigned `download_url` (6h TTL, `FILM_DOWNLOAD_TTL_SECONDS`) whenever a film reaches
`phase: "done"`, and it still does so for a historical film id because the job doc survives in R2.
Verified live against `film-80c356bf-6601-4690-b2cf-3d59d88c3b77`.

What is genuinely missing is narrower and more useful to state precisely:

1. **A key is a dead end.** `list_renders` returns `output_key` and `keyframes[].key` for every
   render in the library. There is no way to turn any of those keys into something fetchable.
   `poll_film`'s URL is the only one in the entire surface, and it covers only the assembled film of
   a job whose id you already hold.
2. **Nothing is ever SEEN.** Even an image, which MCP can carry inline, comes back as a byte count.

## What this pass changes

`GET /api/artifact-url/<key>` (this repo) turns any artifact key into a short-lived presigned GET,
reusing `presignR2Get` -- the same signing path `film-titles`, `cast-image-orchestrator`, and
`wan-lora-projection` already use. A presigned URL is a capability credential that may land in a
transcript or a log, and R2 revocation propagates too slowly for revoke-after-use to be a control,
so the guarantees are **expiry and scope**, both enforced server-side and both negative-tested:

- the signature covers exactly one key, never a prefix or wildcard;
- the lifetime is clamped to `[60, 3600]` seconds, default 300, so a caller cannot widen it;
- the key passes the same guard as the serve route (`isSafeRelKey` + `ARTIFACT_PREFIXES`), so this
  can never sign an object the serve route would refuse;
- existence is checked with `head()`, so a miss is an honest 404 rather than a signed URL that fails
  later at R2.

The MCP-side tools that consume it (`view_artifact`, which returns an image as MCP image content so
an agent literally sees it, and `artifact_url`) ship in `vivijure-mcp`. That package released as
**v1.1.0** and this repo's dependency floor moved to `^1.1.0`, which is why the numbers moved from 19
tools / 18 curated to 21 / 20 at that time. The footnote that produced that wait still stands and is the
reason to trust the number: **this document measures the INSTALLED package**, so it reports the
surface actually deployed rather than one that is merged somewhere. Code on `main` in another repo
moves nothing here; a published version this repo resolves does.

## v1.2.0: the parity wave (cf#317 half 1)

`vivijure-mcp` **v1.2.0** added 21 curated tools (21 -> 42 tools, 20 -> 41 covered route entries) and
this repo's dependency floor is now `^1.2.0`. What it closed, by band:

- **bytes IN** -- `upload_image`, `upload_audio`. The class described in Finding 1.
- **project + render-library write** -- an agent could list and read projects and renders and could
  not create, save, organize or delete one. `get_project` advertised "incl. its last saved
  storyboard" while nothing could write one.
- **cast and identity** -- ten routes covering references, source photos, generated reference sets,
  LoRA training and its status. Identity is step one of driving a film.
- **finishing** -- only the two synchronous routes that act on an already-`COMPLETED` render.

**Deliberately not closed:** render submit, poll and cancel, and the six routes downstream of them.
Each starts a job whose only poll route is `GET /api/storyboard/render/:jobId`, and the render doors
are being reconciled in vivijure-cf#334. A curated submit tool with a blocked poll tool is half a
capability, and 29 tools built on an unreconciled door would freeze the divergence. A test in
`vivijure-mcp` asserts no curated tool aims at one, and is written to be deleted when #334 lands.

The remaining 34 panel-reachable routes with no curated tool are, method-aware, **30**: the 9 blocked
render-door routes, the 19 deliberately left on `studio_request` (internal helpers, module
config, session), and `POST /api/cast/:id/train-wan-lora`, panel-reachable since vivijure-local#329
and with no curated tool yet. Module config write stays on the hatch for a structural reason rather
than a scope one: its body shape is per-module and discovered at runtime from `config_schema`,
so a static `inputSchema` would be either uninformative or a frozen snapshot of one deploy's module set.

## Which way each number here can be wrong

Every measurement in this document can err in ONE direction, and a reader a year from now cannot
work that out from the number. Both instrument defects found while producing this revision ran in
the flattering direction, which is exactly why they survived.

- **Panel-reachable (67) can be too LOW.** Until cf#333 this was a path-only matcher published as
  **70**, and that number could only ever be too HIGH: it compared path segments and ignored METHOD,
  so a route entry inherited reachability from any panel call to its path. It is now derived from the
  panel's own call sites (`fetch`/`api` calls, `.href`/`.src` DOM assignments, one hop of variable
  indirection) and matches on METHOD as well as path, which flips the risk from over- to
  under-counting: a call built through more indirection, or through a shape neither of those two
  covers, is invisible to it. The five entries the old path-only matcher over-counted are named and
  pinned as a regression test (`GET /api/storyboard/projects/:id`, `POST /api/cast/export/:id`,
  `DELETE /api/cast/:id/ref`, `DELETE /api/cast/:id/source`, `HEAD /api/artifact/*key`).
- **Reached by a curated tool (41) can only be too HIGH**, for the same reason at one remove: it is
  exact on method, but a tool that maps to a route says nothing about whether its ARGUMENTS cover
  every field the route accepts. Per-field parity is unmeasured.
- **Route entries (87) can only be too LOW.** It is parsed from the `API_ROUTES` literal, so a route
  registered anywhere else is missed. Exactly one such route exists (`GET /api/modules`) and it is
  added explicitly; a second would be invisible.
- **Panel corpus** was a hand-maintained 36-filename list against a 39-file `public/` until cf#332.
  A new panel file was not added to it, so the measured human surface SHRANK relative to reality
  while every assertion passed. It is now derived by `readdirSync`, and the fix moved no number,
  which is the honest outcome: it was harmless on the day it was written and structurally doomed.

## Method, and what it does not cover

- Route entries are parsed from the `API_ROUTES` literal. A route registered anywhere else would be
  missed; exactly one such route exists today (`GET /api/modules`) and it is added explicitly.
- Panel reachability (cf#333) is method-aware: each call site in `public/*.js` is reduced to
  `{method, template}` (literal URL pieces kept verbatim, each interpolated piece collapsed to the
  same placeholder a route's `:param`/`*param` collapses to) and compared to a route's own template
  for EXACT equality, not substring containment. It covers `fetch(...)`/`api(...)` calls, `.href =`/
  `.src =` DOM assignments (a real browser-issued GET even though no `fetch()` call is written), and
  one bounded hop of `const NAME = ...; fetch(NAME, ...)` variable indirection. It is guarded by a
  positive control (a concatenated route that must match), a negative control (a route that must
  not), and the five named cases cf#333 found the old path-only matcher over-counting, pinned so a
  regression fails with the route in the message. It can still under-match a call built through more
  indirection or a shape outside those two; it is a floor on the human surface, not a proof of each
  row.
- **Not covered:** the control-plane API (`wrangler.control-plane.toml`) is a separate surface and is
  not measured here. Nor is `vivijure-local`, which serves the same contract from a different host.
- **Not covered:** whether each curated tool's arguments cover every field its route accepts. This
  measures route reach, not per-field parity. The POST/PATCH tools forward unknown fields verbatim,
  so the gap is likely small, but it is unmeasured and should not be assumed closed.

## The table

Response column: `json` if the route returns JSON, **bytes** if it returns binary and is therefore
structurally invisible to the MCP.

| Method | Route | Panel | Curated MCP tool | Response |
|---|---|---|---|---|
| `GET` | `/api/storage/usage` | no | -- | json |
| `POST` | `/api/storage/reconcile` | no | -- | json |
| `GET` | `/api/demo/menu` | yes | -- | json |
| `POST` | `/api/demo/render` | yes | -- | json |
| `GET` | `/api/demo/render/:id` | yes | -- | json |
| `POST` | `/api/demo/chat` | yes | -- | json |
| `GET` | `/api/storyboard/projects` | yes | `list_projects` | json |
| `POST` | `/api/storyboard/projects` | yes | `create_project` | json |
| `GET` | `/api/storyboard/projects/:id` | yes | `get_project` | json |
| `PATCH` | `/api/storyboard/projects/:id` | yes | `update_project` | json |
| `POST` | `/api/storyboard/projects/:id/storyboard` | yes | `save_storyboard` | json |
| `DELETE` | `/api/storyboard/projects/:id` | yes | `delete_project` | json |
| `GET` | `/api/voices` | yes | `voices` | json |
| `GET` | `/api/cast` | yes | `list_cast` | json |
| `POST` | `/api/cast` | yes | `create_cast` | json |
| `GET` | `/api/cast/export/:id` | yes | -- | **bytes** |
| `POST` | `/api/cast/export/:id` | yes | -- | **bytes** |
| `POST` | `/api/cast/import` | yes | -- | json |
| `GET` | `/api/cast/:id` | yes | `get_cast` | json |
| `PATCH` | `/api/cast/:id` | yes | `update_cast` | json |
| `DELETE` | `/api/cast/:id` | yes | `delete_cast` | json |
| `POST` | `/api/cast/:id/portrait` | yes | `set_cast_portrait` | json |
| `DELETE` | `/api/cast/:id/portrait` | yes | `clear_cast_portrait` | json |
| `POST` | `/api/cast/:id/ref` | yes | `add_cast_ref` | json |
| `DELETE` | `/api/cast/:id/ref` | yes | -- | json |
| `DELETE` | `/api/cast/:id/refs/*refKey` | yes | `remove_cast_ref` | json |
| `POST` | `/api/cast/:id/source` | yes | `add_cast_source` | json |
| `DELETE` | `/api/cast/:id/source` | yes | -- | json |
| `DELETE` | `/api/cast/:id/source/*sourceKey` | yes | `remove_cast_source` | json |
| `POST` | `/api/cast/:id/generate-refs` | yes | `generate_cast_refs` | json |
| `GET` | `/api/cast/:id/refs-job/:jobId` | yes | `poll_cast_refs` | json |
| `POST` | `/api/cast/:id/train-lora` | yes | `train_cast_lora` | json |
| `POST` | `/api/cast/:id/train-wan-lora` | yes | -- | json |
| `GET` | `/api/cast/:id/lora-status` | yes | `cast_lora_status` | json |
| `POST` | `/api/upload` | yes | `upload_image` | json (**raw body IN**) |
| `GET` | `/api/artifact/*key` | yes | `view_artifact` | **bytes** |
| `HEAD` | `/api/artifact/*key` | yes | -- | **bytes** |
| `GET` | `/api/artifact-url/*key` | no | `artifact_url` | json |
| `POST` | `/api/render/frames` | no | -- | json |
| `POST` | `/api/storyboard/preflight` | yes | `preflight` | json |
| `POST` | `/api/storyboard/plan` | yes | `plan_storyboard` | json |
| `POST` | `/api/storyboard/refine` | yes | `refine_storyboard` | json |
| `POST` | `/api/chat` | yes | `chat` | json |
| `POST` | `/api/storyboard/score-bed` | yes | -- | json |
| `POST` | `/api/storyboard/music-generate` | no | -- | json |
| `GET` | `/api/job/:id` | yes | -- | json |
| `POST` | `/api/storyboard/enhance` | yes | -- | json |
| `GET` | `/api/models` | yes | -- | json |
| `GET` | `/api/storyboard/models` | yes | `storyboard_models` | json |
| `POST` | `/api/storyboard/yaml` | yes | -- | json |
| `POST` | `/api/storyboard/markers` | yes | -- | json |
| `POST` | `/api/storyboard/bundle` | yes | `bundle_storyboard` | json |
| `POST` | `/api/storyboard/audio-upload` | yes | `upload_audio` | json (**raw body IN**) |
| `POST` | `/api/storyboard/character-ref` | yes | -- | json (**raw body IN**) |
| `POST` | `/api/audio/analyze` | yes | -- | json |
| `POST` | `/api/storyboard/render` | yes | -- | json |
| `POST` | `/api/storyboard/render-plan` | no | -- | json |
| `POST` | `/api/render/clips` | no | -- | json |
| `GET` | `/api/render/clips/:id` | no | -- | json |
| `POST` | `/api/render/film` | no | `submit_film` | json |
| `GET` | `/api/render/film/:id` | no | `poll_film` | json |
| `POST` | `/api/storyboard/renders/:id/regen-shot` | yes | -- | json |
| `POST` | `/api/storyboard/render/scatter` | yes | -- | json |
| `POST` | `/api/storyboard/render-from-keyframes` | yes | -- | json |
| `GET` | `/api/storyboard/render/:jobId` | yes | -- | json |
| `DELETE` | `/api/storyboard/render/:jobId` | yes | -- | json |
| `GET` | `/api/storyboard/renders` | yes | `list_renders` | json |
| `GET` | `/api/storyboard/renders/tags` | yes | `render_tags` | json |
| `PATCH` | `/api/storyboard/renders/:id` | yes | `update_render` | json |
| `DELETE` | `/api/storyboard/renders/:id` | yes | `delete_render` | json |
| `POST` | `/api/storyboard/renders/:id/add-audio` | yes | `add_render_audio` | json |
| `POST` | `/api/storyboard/renders/:id/add-narration` | yes | `add_render_narration` | json |
| `POST` | `/api/storyboard/renders/:id/retry` | yes | -- | json |
| `POST` | `/api/storyboard/renders/:id/finalize` | yes | -- | json |
| `POST` | `/api/storyboard/renders/:id/animate-cloud` | yes | -- | json |
| `POST` | `/api/storyboard/renders/:id/animate-hybrid` | yes | -- | json |
| `POST` | `/api/storyboard/renders/adopt` | no | -- | json |
| `GET` | `/api/whoami` | yes | -- | json |
| `GET` | `/api/prefs` | yes | -- | json |
| `PATCH` | `/api/prefs` | yes | -- | json |
| `GET` | `/api/modules/installed` | no | -- | json |
| `POST` | `/api/modules/install` | no | -- | json |
| `DELETE` | `/api/modules/install/:name` | no | -- | json |
| `PATCH` | `/api/modules/install/:name` | no | -- | json |
| `GET` | `/api/modules/:name/config` | yes | -- | json |
| `PATCH` | `/api/modules/:name/config` | yes | -- | json |
| `GET` | `/api/modules` | yes | `studio_modules` | json |

## The tool count moved, as predicted, and here is what moved it (cf#322)

This section previously said the published **19 tools / 18 curated** was transient by design and would
become **21 / 20** the moment the `@skyphusion-labs/vivijure-mcp` dependency bumped. **That has now
happened** (cf#326, dep to `^1.1.0`), and the numbers above are the post-bump ones.

Kept rather than deleted, because the prediction is the useful part: these figures measure the
**INSTALLED** package, which is what the deployed surface actually serves, so they move on a dependency
bump with no change to this repo's own code. A reader who finds a number here that disagrees with a
newer one should check the installed version before filing a regression.

What the bump did NOT change, and this is the part that is easy to get wrong: `view_artifact` and
`artifact_url` both consume EXISTING routes (`GET /api/artifact/*key` and `GET /api/artifact-url/*key`),
so they moved `curatedCovered`, not the route count, and the four structurally-invisible byte-returning
entries stay four. **`view_artifact` makes an image VIEWABLE; it does not make the route stop returning
bytes.**

Separately, `POST /api/render/frames` (cf#322) takes the route count 85 -> 86. It is the reason a
byte-returning clip can be looked at at all: it writes a contact sheet as a normal image artifact, so
the thing the transport can carry is the thing it gets handed. It adds a route, not a curated tool.
