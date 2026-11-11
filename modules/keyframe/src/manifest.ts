// Data-only MANIFEST for keyframe (cf#285).
// Leaf file: no runtime imports beyond the vendored contract constants/types.
// quality-tier-drift (vivijure-core) and local manifest sync import this path so they
// do not pull the module entrypoint's full import graph (runpod-job-log, etc.).
import { MODULE_API, type ModuleManifest } from "./contract";

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's quality_tier enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  name: "keyframe",
  version: "0.3.9",
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "gpu-keyframe", label: "GPU Keyframe (SDXL on RunPod)" }],
  config_schema: {
    quality_tier: {
      type: "enum",
      values: ["draft", "standard", "final"],
      default: "final",
      label: "quality tier",
    },
    // Default to a LANDSCAPE keyframe, the SDXL-friendly 1344x768 bucket. MIND THE RATIO: 1344/768
    // is 1.75 (7:4), NOT 16:9 (1.7778) -- 16:9 at width 1344 would be height 756. Image-to-video
    // backends conform the clip to the KEYFRAME's aspect ratio (they ignore an aspect_ratio param
    // once given an input image), so a square keyframe forced square clips that the assembler then
    // pillarboxed with black bars. A landscape keyframe removes most of that, but 1.75 still does
    // not match the 1920x1080 (1.7778) delivery target, so a thin pillarbox remains: measured at
    // 14px left / 16px right on a 1080p clip. Tracked in cf#945, which is gated on whether SDXL
    // quality holds at 1280x720 or 1920x1080. Override via keyframe_config for portrait/square.
    // (fixes the square showcase clips)
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    steps: { type: "int", default: 30, min: 1, max: 60, label: "diffusion steps" },
    guidance_scale: { type: "float", default: 6.5, min: 0, max: 20, label: "guidance scale" },
    // The backend has no random seed (vivijure-backend#563). -1 is not sent, so the backend draws with its
    // default keyframe seed (KeyframeConfig.seed, src/vivijure_backend/config.py), the same picture every time.
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = backend default, same picture each time)" },
    // cf#299: expose InstantID on the studio door. Backend default is ip_adapter;
    // "instantid" selects the insightface face path (proven on vivijure-backend).
    identity_method: {
      type: "enum",
      values: ["ip_adapter", "instantid"],
      default: "ip_adapter",
      label: "face identity method",
    },
    // Keep people in the location still (plate then face). Off is a debug hatch.
    // Safe no-op on backend images that do not know the key. No scene_denoise.
    scene_lock: {
      type: "bool",
      default: true,
      label: "keep people in the scene",
    },
    canny_scale: {
      type: "float",
      default: 0.7,
      min: 0,
      max: 1,
      label: "scene lock strength",
    },
    // cf#1143: how much around each face the scene-lock pass takes from the cast portrait. 0.35 is the face
    // and little hair, the shipped crop. Larger keeps the hair and shoulders. Older backend images ignore it.
    face_crop_pad: {
      type: "float",
      default: 0.35,
      min: 0,
      max: 2,
      label: "face reference margin",
    },
    // cf#1143: on a two-person shot, how strongly the first (scene) pass takes each person's portrait in their half
    // of the frame. 0 is off, the plate as before. Older backend images ignore it.
    plate_ip_adapter_scale: {
      type: "float",
      default: 0,
      min: 0,
      max: 1,
      label: "two-person portrait strength",
    },
    // cf#1143 option a: on a two-person shot, each person's description reaches only their own half of the first
    // (scene) pass, while the scene, style, setting and the adult statement stay for the whole frame. Off = one
    // prompt for the frame, as before. Older backend images ignore it.
    plate_regional_text: {
      type: "bool",
      default: false,
      label: "keep each person's look to themselves",
    },
    // cf#1143 option c: with the setting above on, the space between the two people reads only the look and the
    // place, not the shot's sentence that names them, so it is not asked to draw a third person. Off = as before.
    plate_people_free_background: {
      type: "bool",
      default: false,
      label: "nobody in the gap between two people",
    },
    // cf#1143 option d: how firmly a two-person still plants exactly two bodies. 0.55 is the value shipped
    // before. Sent to the backend as multi_char.controlnet_pose_scale, which clamps it to 0..1.5.
    pose_scale: {
      type: "float",
      default: 0.55,
      min: 0,
      max: 1.5,
      label: "two-person body placement strength",
    },
    // cf#1281: whether a two-person still draws under the pose skeleton. "auto" sends nothing, so the backend
    // picks per path (backend#596: a scene-lock plate draws without it while the plate count guard runs; the
    // plain regional path draws with it). "on" or "off" sets both paths. An enum, not a bool, because the core
    // fills every schema default, so a bool could never be left unset.
    pose_conditioning: {
      type: "enum",
      values: ["auto", "on", "off"],
      default: "auto",
      label: "two-person pose skeleton",
    },
    // Photoreal is RealVisXL (baked default). Anime is refused at invoke, before any RunPod call (cf#1384):
    // Animagine is not on the GPU image and anime stills run on cloud-keyframe (vivijure-backend#557). It
    // stays in the enum because core clamps an undeclared value to the default, which would draw photoreal.
    style: {
      type: "enum",
      values: ["photoreal", "anime"],
      default: "photoreal",
      label: "still look",
    },
  },
  ui: { section: "keyframe", order: 10 },
  // This module is async + GPU-backed, so it implements POST /cancel: the core can stop an in-flight
  // RunPod job (a cancelled render, or an adopted keyframe phase) instead of orphaning it (#327/#328).
  cancelable: true,
  // #454: compact display token for the keyframe-stage backend, so the planner projects it inline
  // instead of hardcoding "SDXL". OPTIONAL/additive, mirrors src/modules/types.ts.
  keyframe_label: "SDXL",
  // cp#270: this module submits to the vivijure-backend endpoint, which may be POOLED across
  // tenants, so it needs the tenant's per-job R2 credential on the invoke envelope. Declared on
  // the MANIFEST rather than decided in core: which modules ride a pooled endpoint is a property
  // of the module, and core must not branch on module identity.
  needs_tenant_r2: true,
  // A slot with no adapter trains in the job (core#370), so the core must not split that film.
  trains_loras: true,
};
