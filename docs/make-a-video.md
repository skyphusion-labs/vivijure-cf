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
| Voices | for a plan that talks: `GET /api/voices`, then `PATCH /api/cast/:id` `{ voice_id }` for each person with no voice |
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
3. A **voice-file** module (`usage.driving_audio` without `usage.native_audio`, today InfiniteTalk
   and `cf-p-video-avatar`) is graded 3 for a plan that talks. The picture is our still from the cast
   photos and only the mouth moves, and the voice is the person's own Cast voice on every line. The
   native-audio modules invent a voice ("Cannot lock the Cast voice sample"). A shot with no line still
   works, because core mints silence for it (core#342). It is not eligible before the plan exists, or
   for a plan with no lines, because an all-silent video on it is a still picture. No voice-file
   module declares an aspect choice, and none has proven a frame other than wide (InfiniteTalk: "480p
   only (832x464)"; `cf-p-video-avatar`: its shape "is unknown until a real render"), so a voice-file
   module is offered for **Wide only**. Vertical and Square talking plans take the best native-audio
   module. It is also skipped when someone cannot be bound to the video (next section), because that
   person would speak in the studio's one default voice.
4. When the plan has spoken lines, only modules that can speak are eligible. The pick is made on
   face grade before the plan exists and made again once the plan is back, so the confirm always
   shows the style that will run.
5. Ties go to the stronger voice lock (the person's own voice), then a module that can speak (only
   while talking is unknown), then `ui.order`, then name. **Price never breaks a tie.**

So a talking plan in Wide gets InfiniteTalk (then `cf-p-video-avatar` when InfiniteTalk is not
installed), and Vertical or Square gets `cf-vidu-q3-turbo`. `cf-seedance` is grade ONE since cf#954 (it does not end on the end still), so it is no longer a fallback.

Each module states its own grade in `usage.face_hold` (`hold`, `two`, `one`, `drift`; cf#1246), and
the page reads it. A module that predates the field falls back to the generic facts above. The values
were set to the grades the old name table gave, and
`tests/motion-door-price-face-1246.test.ts` proves no module's grade changed in the switch. One name is
left, declared in `tests/panel-no-hardcoded-modules.test.ts`: `alibaba-wan-lora` needs the trained
Wan look, and no manifest field says so yet.

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

Prices are **at cost**: the provider's price with nothing added, until an end-user markup is set
(Conrad, 2026-11-05). A module states one of two fields (cf#1246):

- `ui.cost_usd_per_second`, `[lowest resolution, highest resolution]`, the same figure the planner's
  spend confirm uses. Lowest resolution is priced at the first figure and highest at the second;
  anything between is priced at the second and shown as "up to".
- `ui.cost_usd_per_clip`, a list of `{usd, resolution?, seconds?}`, where a missing key matches any
  value. The page takes the resolution the quality picks and the scene's length, and finds the entry.
  No entry is "price unknown".

Each scene is priced at the length the module really makes: inside its `min_seconds` and
`max_seconds`, then rounded up to its `duration_steps`. So on `alibaba-wan`, which makes 5, 10 or 15
second clips, a 7 second scene is priced as 10. The planner's video style cards show the same price
line ("$0.04 to $0.07 a second, at cost"), and the day it was read when the module states
`ui.cost_as_of`.
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

## Voices

A person's voice reaches the video through their binding (`castLoras`), which carries the cast row's
`voice_id`. Core speaks an unbound person, or one with no `voice_id`, in the default voice
(`DEFAULT_VOICE_ID`, `angus`), so two such people would share one voice. Two rules follow:

- For a plan that talks, everyone with no voice gets the next voice from `GET /api/voices` that no one
  else in the video has, saved on their cast row before the video starts. The confirm names them, and
  the Cast page can change it.
- A person is bound only when the server accepts it: a stills module that trains the look
  (`trains_loras`) refuses a person whose look is not ready. If anyone cannot be bound, the
  voice-file modules are skipped for that video.

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
