// cloud-keyframe: a `keyframe` module worker (vivijure-module/2), GPUless. It turns a project's
// storyboard into one START keyframe per shot via reference-conditioned CLOUD image generation -- no
// GPU backend, no RunPod, NO LoRA. Character identity comes from the cast PORTRAITS packed in the
// bundle (the same portraits a LoRA would have trained on), conditioned through FLUX-2 multiref or
// nano-banana-pro image_input. This is the cost-door: cloud keyframe + cloud i2v = a film path with
// zero GPU rental.
//
// ASYNC: a multi-shot project can't render inside one Worker request (a cloud gen is seconds each), so:
//   GET  /module.json -> manifest
//   POST /invoke      -> read the bundle, stage each cast portrait (downscaled), plan the shots, write
//                        run state to R2, return { ok, pending, poll }
//   POST /poll        -> render the next shot, write its keyframe to R2, advance; pending until done
// PollResponse carries no token, so the run state lives in R2 and the poll token is a stable pointer.
//
// This is a PRODUCER stage, not a polish step: a shot it cannot render is an honest HARD FAIL
// (ok:false), never a soft-degrade and never a fake keyframe -- nothing downstream can animate a frame
// that was never rendered. Failures are DATA, never an exception across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type KeyframeInput,
  type KeyframeOutput,
} from "./contract";
import { generateImage, maxRefsForModel, type AiRun } from "./image-gen";
import {
  gunzipBundle,
  extractTarText,
  extractTarBytes,
  listTarNames,
  parseScenes,
  parseStylePrefix,
  parseRegistry,
  refsForSlot,
} from "./bundle";
import {
  MODELS,
  clampModel,
  clampDim,
  clampRefsPerSlot,
  composePrompt,
  keyframeKey,
  stageRefKey,
  stateKey,
  selectScenes,
  usedSlots,
  encodePoll,
  decodePoll,
  readOutput,
  parseFilmRef,
  planShotRefs,
  FILM_REF_SLOT,
  type CloudKeyframeState,
  type ShotPlan,
} from "./keyframe";

const REF_MAX_DIM = 512; // FLUX-2's hard per-image input cap; also bounds the nano-banana data URIs.

/** Minimal Cloudflare Images binding shape: input -> transform -> output. Used to downscale refs and
 *  to normalize each keyframe to the configured dimensions (pinning aspect for models that pick their
 *  own). Optional so the module still runs un-bound, but it should stay bound in prod. */
interface ImagesTransformer {
  transform(opts: Record<string, unknown>): ImagesTransformer;
  output(opts: { format: string }): Promise<{ response(): Response }>;
}
interface ImagesBinding {
  input(stream: ReadableStream): ImagesTransformer;
}

interface R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  text(): Promise<string>;
}
interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

interface Env {
  AI: AiRun;              // AI binding: FLUX-2 run direct (gateway-bypassed); proxied models via the gateway
  GATEWAY_ID?: SecretsStoreSecret;    // AI Gateway slug (secret); needed only for the proxied / nano-banana path
  R2_RENDERS: R2Bucket;   // the shared `vivijure` bucket: bundle, staged refs, run state, keyframes
  IMAGES?: ImagesBinding; // Cloudflare Images: downscale refs to <=512px; normalize keyframes to WxH
}

export const MANIFEST: ModuleManifest = {
  name: "cloud-keyframe",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "cloud-keyframe", label: "Cloud Keyframe (reference-conditioned, GPUless)" }],
  config_schema: {
    model: {
      type: "enum",
      values: [...MODELS],
      default: MODELS[0],
      label: "image model (FLUX-2 klein-9b cheap/fast; nano-banana-pro quality)",
    },
    // Default to a 16:9 landscape keyframe (1344x768), matching the GPU keyframe module: image-to-video
    // backends conform the clip to the KEYFRAME's aspect ratio, so a square keyframe forces square
    // clips that the assembler then pillarboxes. A 16:9 keyframe keeps the whole chain 16:9.
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    refs_per_slot: { type: "int", default: 1, min: 1, max: 4, label: "reference images per character" },
    // cp#32: one film-wide reference appended to EVERY shot (character-less shots included) to lock
    // style/realism across the film. STRING not enum: the cast anchor <slot> is per-project and a
    // static enum cannot carry it. Grammar: none | first_keyframe | cast:<slot>. Default none = no-op.
    film_ref: { type: "string", default: "none", label: "film-wide reference lock (none | first_keyframe | cast:<slot>)" },
  },
  ui: { section: "keyframe", order: 20 },
};

// One shot rendered per /poll cycle: keeps each poll inside the Worker time budget while finishing the
// project in a handful of polls.
const PER_POLL = 1;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset/unreadable so the existing "not configured" guards still fire. */
async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

/** Downscale a portrait to fit within REF_MAX_DIM (long edge), preserving aspect, never upscaling.
 *  Best-effort: with no Images binding, the original bytes are returned (FLUX-2 may then reject an
 *  oversized ref, surfacing as a gen HARD FAIL the caller already handles). */
async function downscaleRef(images: ImagesBinding | undefined, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!images) return bytes;
  try {
    const out = await images
      .input(new Blob([bytes]).stream())
      .transform({ width: REF_MAX_DIM, height: REF_MAX_DIM, fit: "scale-down" })
      .output({ format: "image/png" });
    return await out.response().arrayBuffer();
  } catch {
    return bytes;
  }
}

/** Normalize a generated keyframe to EXACTLY width x height (PNG) -- the second half of the aspect
 *  pin. The first half already ran in image-gen: FLUX-2 was given width/height, and nano-banana was
 *  asked for the target aspect_ratio so it FRAMED for that shape (no head/feet loss on a full-body
 *  shot). So by the time we get here the frame is already at (FLUX) or near (nano) the target, and
 *  this fit:"cover" finish is the exact-dimension trim -- trivial, not a body-cropping hack -- that
 *  guarantees the keyframe aspect the downstream i2v conforms to. Best-effort: with no Images binding,
 *  the raw bytes pass through (FLUX is already exact; nano would be near-target but un-finished). */
async function normalizeKeyframe(
  images: ImagesBinding | undefined,
  bytes: ArrayBuffer,
  width: number,
  height: number,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  if (!images) return { bytes, mime: "image/png" };
  const out = await images
    .input(new Blob([bytes]).stream())
    .transform({ width, height, fit: "cover" })
    .output({ format: "image/png" });
  return { bytes: await out.response().arrayBuffer(), mime: "image/png" };
}

/** /invoke: read the bundle, stage each used cast portrait (downscaled), plan the shots, persist the
 *  run state, and return a stable poll pointer. No generation here -- /poll does the work, one shot at
 *  a time. A bundle / storyboard / portrait it cannot read is a HARD FAIL (no keyframe can follow). */
async function submit(env: Env, req: InvokeRequest<KeyframeInput>): Promise<InvokeResponse<KeyframeOutput>> {
  const input = req.input;
  if (!input || !input.project || !input.bundle_key) {
    return { ok: false, error: "cloud-keyframe: input needs project and bundle_key" };
  }
  const model = clampModel(req.config.model);
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (model.startsWith("google/") && !gatewayId) {
    return { ok: false, error: "cloud-keyframe: GATEWAY_ID not configured (required for the proxied model)" };
  }
  const width = clampDim(req.config.width, 1344);
  const height = clampDim(req.config.height, 768);
  const refsPerSlot = clampRefsPerSlot(req.config.refs_per_slot);

  let tar: Uint8Array | null;
  try {
    tar = await gunzipBundle(env.R2_RENDERS, input.bundle_key);
  } catch (e) {
    return { ok: false, error: "cloud-keyframe: could not read bundle: " + (e as Error).message };
  }
  if (!tar) return { ok: false, error: "cloud-keyframe: bundle not found at " + input.bundle_key };

  const yaml = extractTarText(tar, "storyboard.yaml");
  if (!yaml) return { ok: false, error: "cloud-keyframe: bundle has no storyboard.yaml" };
  const scenes = parseScenes(yaml);
  const stylePrefix = parseStylePrefix(yaml);
  const registryJson = extractTarText(tar, "characters/registry.json");
  const registry = registryJson ? parseRegistry(registryJson) : {};

  const selected = selectScenes(scenes, input.shot_ids);
  if (selected.length === 0) {
    return { ok: false, error: "cloud-keyframe: no shots to render (empty storyboard or no matching shot_ids)" };
  }

  // Stage each used slot's reference portrait(s), downscaled, as standalone R2 objects the per-shot
  // polls read. A used slot with no portrait in the bundle is a HARD FAIL: the shot names a character
  // we cannot render with identity.
  const filmPlan = parseFilmRef(req.config.film_ref);
  if (!filmPlan) {
    return { ok: false, error: "cloud-keyframe: unknown film_ref (use none | first_keyframe | cast:<slot>)" };
  }

  const job_id = crypto.randomUUID();
  const tarNames = listTarNames(tar);
  const slot_refs: Record<string, string[]> = {};
  // Stage every used slot; for film_ref=cast:<slot> also stage the anchor slot even if no selected
  // shot features it, so its portrait can seed the film-wide reference.
  const slotsToStage = usedSlots(selected);
  if (filmPlan.mode === "cast" && filmPlan.slot && !slotsToStage.includes(filmPlan.slot)) {
    slotsToStage.push(filmPlan.slot);
  }
  for (const slot of slotsToStage) {
    const candidates: string[] = [];
    const reg = registry[slot];
    if (reg?.image) candidates.push(reg.image);
    for (const r of refsForSlot(tarNames, slot)) if (!candidates.includes(r)) candidates.push(r);
    const chosen = candidates.slice(0, refsPerSlot);
    const keys: string[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const raw = extractTarBytes(tar, chosen[i]);
      if (!raw) continue;
      const small = await downscaleRef(env.IMAGES, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
      const key = stageRefKey(input.project, job_id, slot, i + 1);
      try {
        await env.R2_RENDERS.put(key, small, { httpMetadata: { contentType: "image/png" } });
      } catch (e) {
        return { ok: false, error: "cloud-keyframe: could not stage ref for slot " + slot + ": " + (e as Error).message };
      }
      keys.push(key);
    }
    if (keys.length === 0) {
      return { ok: false, error: "cloud-keyframe: slot " + slot + " has no portrait in the bundle (cannot render its shots)" };
    }
    slot_refs[slot] = keys;
  }

  // cp#32: stage the one film-wide reference. cast:<slot> -> the anchor slot canonical portrait
  // (the staging loop already hard-failed if it had none). first_keyframe -> deferred to poll,
  // which captures the first rendered keyframe into __film__. none -> nothing.
  if (filmPlan.mode === "cast" && filmPlan.slot) {
    slot_refs[FILM_REF_SLOT] = [slot_refs[filmPlan.slot][0]];
  }

  const shots: ShotPlan[] = selected.map((s) => ({
    shot_id: s.shot_id,
    prompt: composePrompt(stylePrefix, s.prompt, s.slots, registry),
    slots: s.slots,
  }));

  const state: CloudKeyframeState = {
    project: input.project,
    job_id,
    model,
    width,
    height,
    slot_refs,
    shots,
    done: [],
    total: shots.length,
    film_ref: filmPlan,
  };
  try {
    await env.R2_RENDERS.put(stateKey(input.project, job_id), JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    return { ok: false, error: "cloud-keyframe: could not persist run state: " + (e as Error).message };
  }
  return { ok: true, pending: true, poll: encodePoll({ project: input.project, job_id }), jobId: job_id };  // #318 (additive); cloud-keyframe writes no progress snapshot -> core gets no sub-progress, degrades gracefully
}

/** /poll: load the run state, render the next shot (gen -> normalize -> store), advance, and return
 *  pending until the shot queue drains -> the KeyframeOutput with every keyframe key. Any failure to
 *  render or store a shot is a HARD FAIL. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<KeyframeOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "cloud-keyframe: bad poll token" };
  const sk = stateKey(token.project, token.job_id);
  const obj = await env.R2_RENDERS.get(sk);
  if (!obj) return { ok: false, error: "cloud-keyframe: run state not found (expired or bad token)" };
  const state = JSON.parse(await obj.text()) as CloudKeyframeState;
  if (state.shots.length === 0) return { ok: true, output: readOutput(state) };
  const gatewayId = await secretValue(env.GATEWAY_ID);

  for (let n = 0; n < PER_POLL && state.shots.length > 0; n++) {
    const shot = state.shots[0];

    // Gather this shot own character refs first, then the film-wide reference into the leftover
    // capacity (cp#32). planShotRefs guarantees the film ref never evicts a character ref.
    const { charKeys, filmKeys } = planShotRefs(state.slot_refs, shot.slots, maxRefsForModel(state.model));
    const refBlobs: Blob[] = [];
    for (const key of charKeys) {
      const r = await env.R2_RENDERS.get(key);
      if (r) refBlobs.push(await r.blob());
    }
    if (shot.slots.length > 0 && refBlobs.length === 0) {
      return { ok: false, error: "cloud-keyframe: shot " + shot.shot_id + " lost its staged references" };
    }
    for (const key of filmKeys) {
      const r = await env.R2_RENDERS.get(key);
      if (r) refBlobs.push(await r.blob());
    }

    let gen: { bytes: ArrayBuffer; mime: string };
    try {
      gen = await generateImage(env.AI, gatewayId, state.model, shot.prompt, refBlobs, state.width, state.height);
    } catch (e) {
      return { ok: false, error: "cloud-keyframe: shot " + shot.shot_id + " render failed: " + (e as Error).message };
    }

    let norm: { bytes: ArrayBuffer; mime: string };
    try {
      norm = await normalizeKeyframe(env.IMAGES, gen.bytes, state.width, state.height);
    } catch (e) {
      return { ok: false, error: "cloud-keyframe: shot " + shot.shot_id + " normalize failed: " + (e as Error).message };
    }

    const key = keyframeKey(state.project, shot.shot_id);
    try {
      await env.R2_RENDERS.put(key, norm.bytes, { httpMetadata: { contentType: norm.mime } });
    } catch (e) {
      return { ok: false, error: "cloud-keyframe: shot " + shot.shot_id + " R2 put failed: " + (e as Error).message };
    }

    state.done.push({ shot_id: shot.shot_id, keyframe_key: key });

    // cp#32 first_keyframe: the first rendered keyframe becomes the film-wide reference for the rest.
    // Downscaled + staged like a cast portrait so all refs stay uniformly <=512. Best-effort: a
    // staging miss means the rest render without the lock (drift, not a broken keyframe).
    if (state.film_ref?.mode === "first_keyframe" && !(state.slot_refs[FILM_REF_SLOT]?.length)) {
      try {
        const small = await downscaleRef(env.IMAGES, norm.bytes);
        const frKey = stageRefKey(state.project, state.job_id, FILM_REF_SLOT, 1);
        await env.R2_RENDERS.put(frKey, small, { httpMetadata: { contentType: "image/png" } });
        state.slot_refs[FILM_REF_SLOT] = [frKey];
      } catch (e) {
        console.warn("cloud-keyframe: could not stage first_keyframe film ref: " + (e as Error).message);
      }
    }
    state.shots.shift();
  }

  try {
    await env.R2_RENDERS.put(sk, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  } catch {
    /* best-effort: the next poll re-reads the prior state and continues */
  }
  return state.shots.length === 0 ? { ok: true, output: readOutput(state) } : { ok: true, pending: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<KeyframeInput>;
      try {
        req = (await request.json()) as InvokeRequest<KeyframeInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "keyframe") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await submit(env, req));
    }

    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try {
        body = (await request.json()) as PollRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as PollResponse);
      }
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as PollResponse);
      }
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
