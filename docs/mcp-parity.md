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
| Studio API route entries | **85** | Distinct `method` + `pattern` pairs the studio serves. 84 in `API_ROUTES` plus `GET /api/modules`, which is dispatched before the table (it opts into a 60s isolate cache) and would otherwise be silently uncounted. |
| Panel-reachable | **70** | Route entries the studio panel calls, i.e. the human surface. Matched from `public/` with controls in both directions. |
| MCP tools | **21** | 20 curated tools plus the `studio_request` escape hatch. |
| Reached by a CURATED tool | **20** | Route entries with a purpose-built tool. |
| Reachable via `studio_request` | **85** | Every route. The escape hatch takes an arbitrary method + path. |
| Structurally invisible to the MCP | **4** | Route entries whose response is BYTES. |

Two of those rows are the whole finding, and they point in opposite directions from what the issue
assumed.

## Finding 1: action parity is NOT the gap

`studio_request` sends any method to any path with the studio bearer. There is no route in the
contract an agent cannot invoke. Curated coverage is 20 of 85 (24%), and that number measures
**ergonomics**, not capability: a curated tool means the agent does not have to know the contract to
find the route. A low number here costs discoverability, not reach.

So the honest answer to "can an agent do everything a human can do" is **yes, already**, with the
caveat that 65 routes require the agent to read `docs/CONTRACT.md` first.

Note the asymmetry the table makes visible: parity is not a subset relation in either direction.
`POST /api/render/film` and `GET /api/render/film/:id` -- the film submit and poll the MCP is built
around -- are **not panel-reachable at all**. The panel renders through `/api/storyboard/render`.
The agent surface and the human surface overlap; neither contains the other.

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
**v1.1.0** and this repo's dependency is now `^1.1.0`, which is why the numbers above moved from 19
tools / 18 curated to **21 / 20**. The footnote that produced that wait still stands and is the
reason to trust the number: **this document measures the INSTALLED package**, so it reports the
surface actually deployed rather than one that is merged somewhere. Code on `main` in another repo
moves nothing here; a published version this repo resolves does.

## Method, and what it does not cover

- Route entries are parsed from the `API_ROUTES` literal. A route registered anywhere else would be
  missed; exactly one such route exists today (`GET /api/modules`) and it is added explicitly.
- Panel reachability matches each route's literal segments across a bounded gap, because the panel
  builds URLs both by concatenation and as template literals. It is guarded by a positive control (a
  concatenated route that must match) and a negative control (a route that must not). It can still
  in principle over-match; it is a floor on the human surface, not a proof of each row.
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
| `POST` | `/api/storyboard/projects` | yes | -- | json |
| `GET` | `/api/storyboard/projects/:id` | yes | `get_project` | json |
| `PATCH` | `/api/storyboard/projects/:id` | yes | -- | json |
| `POST` | `/api/storyboard/projects/:id/storyboard` | yes | -- | json |
| `DELETE` | `/api/storyboard/projects/:id` | yes | -- | json |
| `GET` | `/api/voices` | yes | `voices` | json |
| `GET` | `/api/cast` | yes | `list_cast` | json |
| `POST` | `/api/cast` | yes | `create_cast` | json |
| `GET` | `/api/cast/export/:id` | yes | -- | **bytes** |
| `POST` | `/api/cast/export/:id` | yes | -- | **bytes** |
| `POST` | `/api/cast/import` | yes | -- | json |
| `GET` | `/api/cast/:id` | yes | `get_cast` | json |
| `PATCH` | `/api/cast/:id` | yes | `update_cast` | json |
| `DELETE` | `/api/cast/:id` | yes | -- | json |
| `POST` | `/api/cast/:id/portrait` | yes | `set_cast_portrait` | json |
| `DELETE` | `/api/cast/:id/portrait` | yes | -- | json |
| `POST` | `/api/cast/:id/ref` | yes | -- | json |
| `DELETE` | `/api/cast/:id/ref` | yes | -- | json |
| `DELETE` | `/api/cast/:id/refs/*refKey` | yes | -- | json |
| `POST` | `/api/cast/:id/source` | yes | -- | json |
| `DELETE` | `/api/cast/:id/source` | yes | -- | json |
| `DELETE` | `/api/cast/:id/source/*sourceKey` | yes | -- | json |
| `POST` | `/api/cast/:id/generate-refs` | yes | -- | json |
| `GET` | `/api/cast/:id/refs-job/:jobId` | yes | -- | json |
| `POST` | `/api/cast/:id/train-lora` | yes | -- | json |
| `POST` | `/api/cast/:id/train-wan-lora` | no | -- | json |
| `GET` | `/api/cast/:id/lora-status` | yes | -- | json |
| `POST` | `/api/upload` | yes | -- | json |
| `GET` | `/api/artifact/*key` | yes | `view_artifact` | **bytes** |
| `HEAD` | `/api/artifact/*key` | yes | -- | **bytes** |
| `GET` | `/api/artifact-url/*key` | no | `artifact_url` | json |
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
| `POST` | `/api/storyboard/audio-upload` | yes | -- | json |
| `POST` | `/api/storyboard/character-ref` | yes | -- | json |
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
| `GET` | `/api/storyboard/renders/tags` | yes | -- | json |
| `PATCH` | `/api/storyboard/renders/:id` | yes | -- | json |
| `DELETE` | `/api/storyboard/renders/:id` | yes | -- | json |
| `POST` | `/api/storyboard/renders/:id/add-audio` | yes | -- | json |
| `POST` | `/api/storyboard/renders/:id/add-narration` | yes | -- | json |
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
