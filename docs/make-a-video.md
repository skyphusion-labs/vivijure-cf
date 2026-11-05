# Make a video (cf#1242)

A one-screen page for a first-time creator: who is in it, the idea, where it will be posted,
quality, one total, one button, then a progress bar and the finished video. It lives at `/make`
(`public/make.html`, `public/make.js`, `public/make.css`). With `PANEL_HOME=simple` it is also the
landing page (see `docs/DEPLOYMENT.md`, "Landing page").

The page adds no API. Every step calls a route the planner or the cast page already uses:

| Step | Routes |
|---|---|
| Who's in it | `GET /api/cast`; Add someone = `POST /api/cast`, `POST /api/upload`, `POST /api/cast/:id/portrait`, `POST /api/cast/:id/generate-refs` + `GET /api/cast/:id/refs-job/:jobId`, then `GET /api/cast/:id/lora-status` while the trained look learns |
| Style | `GET /api/modules`, read by `public/make-style.js` |
| Plan | `POST /api/storyboard/plan`, with the first model `GET /api/storyboard/models` lists |
| Save | `POST /api/storyboard/projects`, then `POST /api/storyboard/projects/:id/storyboard` |
| Make | `POST /api/storyboard/bundle`, then `POST /api/storyboard/render` |
| Progress | `GET /api/storyboard/render/:jobId`, read with `public/render-eta.js` |

## The default style: face consistency first

Conrad's ruling: the video style is chosen for **face consistency first, not price**. The rule
is `public/make-style.js` (pure, unit tested in `tests/make-style.test.ts`). In order:

1. Only installed `motion.backend` modules count.
2. Each gets a face grade:

   | Grade | Name | Meaning | Source |
   |---|---|---|---|
   | 3 | HOLD | The module itself holds the face | its manifest prose and `docs/motion-door-limits.md` |
   | 2 | TWO | A start and an end still on every clip (`usage.first_last`), both drawn from the cast photos | the manifest |
   | 1 | ONE | One start still; the face can wander inside the clip | the manifest |
   | 0 | DRIFT | Faces drift | `docs/motion-door-limits.md` |

   Only grades 2 and 3 are consistency grade. Grade 1 and 0 are never picked.
3. A module that only plays a voice file (`usage.driving_audio` without `usage.native_audio`) is
   never the default. It refuses or freezes a shot with no line, and a short video from an idea
   usually has some.
4. When the plan has spoken lines, only modules that can speak are eligible. The pick is made on
   face grade before the plan exists and made again once the plan is back, so the confirm always
   shows the style that will run.
5. Ties go to a module that can speak (only while talking is unknown), then `ui.order`, then name.
   **Price never breaks a tie.**

Three modules are graded from prose rather than from a manifest field, because no manifest field
carries a face-hold fact yet. They are declared in `tests/panel-no-hardcoded-modules.test.ts`:

| Module | Grade | Evidence |
|---|---|---|
| `alibaba-wan-lora` | 3, needs the trained Wan look | provides label "Silent, your trained face (Wan)"; this repo's door limits: "with your trained face" |
| `cf-hh1-r2v` | 3 | blurb "Holds a look from reference stills"; door limits: "silent look lock" |
| `cf-flux-3-video` | 0 | blurb and door limits: "Faces drift". It declares `usage.first_last`, so the generic rule alone would rank it 2 |

The fix that retires this table is a manifest field (for example `usage.face_hold`) reported to the
module lane; the page then reads it like any other projected fact.

`alibaba-wan-lora` is usable only when the host can train the Wan look (`GET /api/cast`
`wan_lora_trainable`) or every chosen person already has it. When it is chosen and someone lacks
the look, the confirm says so with the cast page's own figure (about 35-45 min each) and the page
trains it before the video starts.

## Shapes

An image-to-video module makes the clip at the shape of its start still (the keyframe manifests:
"Image-to-video backends conform the clip to the KEYFRAME's aspect ratio"). So a shape is possible
when:

- the stills module that draws the cast can draw that size within its declared `width` / `height`
  range (Vertical 768x1344, Square 1024x1024, Wide 1344x768), and
- the motion module either declares an aspect enum (`aspect_ratio` or `ratio`) that contains the
  shape, or declares none and follows the still.

The stills module is the one that trains the cast's look (`trains_loras`), else the first installed.
**A shape no consistency-grade module can make is not offered**, rather than handed to a weaker one.
If none can make any shape, the page says so and points at the advanced planner.

## Quality and price

Draft, Good and Best are the core tiers `draft`, `standard` and `final` (`render.quality_tiers`).
Where a module has a resolution choice, Draft asks for its lowest, Best its highest, Good its
default.

Price comes from the module's own `ui.cost_usd_per_second`, which is `[lowest resolution, highest
resolution]`, the same figure the planner's spend confirm uses. Lowest resolution is priced at the
first figure and highest at the second; anything between is priced at the second and shown as
"up to". The total is that rate times the planned seconds (the seconds the render submit sends).
Before the plan exists the total says it comes after planning, and each quality shows the price for
10 seconds. **A module with no stated rate shows "price unknown", never a number.** The figure covers
the moving video only; pictures and voices have no stated price anywhere the page can read, and the
page says so.

Time per quality is not measured anywhere the page can read before a first video, so it says
"Time not known yet". The progress screen estimates time left from real progress
(`renderEta.remainingMs`).

## Faces

Adding someone creates the cast member, sets the selfie as the portrait, and starts the cast
pictures (`generate-refs`). That job starts the trained look by itself once enough pictures exist.
When the stills module uses the trained look (`trains_loras`), making the video waits for it. The
waits use the cast page's figures: about 2-4 min for pictures, about 15-25 min for the look. A
trained look is bound to the video only when it is `ready`, because a bound look that is not ready
fails the video.

## Plain words

The page avoids these words in anything a person reads. `tests/browser/make-video.mjs` checks the
rendered text against this list:

| Avoided | Said instead |
|---|---|
| storyboard | plan |
| shot | (not named; "about N seconds") |
| slot | (not named; people by name) |
| seed | (not shown) |
| keyframe | picture |
| backend, door | style |
| LoRA | "learning their face" |
| YAML, file names | (not shown) |
| render | make, video |
