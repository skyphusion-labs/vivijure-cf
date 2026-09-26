// Planner module registry: the planner-facing helpers over GET /api/modules. The fetch itself
// belongs to module-registry.js since cf#580, which memoises it ONCE PER PAGE across every script
// rather than once per planner. No feature names or providers are hardcoded here -- only hook names
// from the vivijure-module/2 contract.
(function (global) {
  // cf#580: the memo MOVED to module-registry.js, which every page now loads. This file keeps the
  // planner-facing helpers and DELEGATES the fetch rather than holding a second independent memo.
  // Two memos on one page is the same defect relocated, not fixed: planner.html would issue two GET
  // /api/modules, one for the page chrome and one for the planner controls.
  //
  // The public contract of load() and registryUnavailable() is UNCHANGED; only ownership of the
  // in-flight promise moved. Contract in full (never rejects, one flight, empty shape plus a flag on
  // failure, no TTL, no retry) is documented in module-registry.js.
  let cache = null;

  // Resolved at CALL time, and THROWS when the shared registry is absent rather than falling back to
  // an own fetch. A silent fallback would rebuild the second memo and read as working, which is
  // exactly the failure mode this change is about. Same discipline as pollPolicy() in demo-steer.js.
  // The lookup order covers a browser page, a new Function() harness that passes a window scope, and
  // a plain-Node eval.
  function registry() {
    const mr =
      (typeof moduleRegistry !== "undefined" && moduleRegistry) ||
      (global && global.moduleRegistry) ||
      (typeof globalThis !== "undefined" && globalThis.moduleRegistry);
    if (!mr) {
      throw new Error(
        "module-registry.js is not loaded; refusing to re-open the per-page /api/modules fan-out (cf#580)",
      );
    }
    return mr;
  }

  // The local cache mirror is what the SYNCHRONOUS helpers below read, so their pre-load behaviour is
  // unchanged: they return empty until a load() has resolved.
  function load() {
    return registry()
      .load()
      .then((d) => {
        cache = d;
        return d;
      });
  }

  // cf#344: did the projection actually ARRIVE? An empty cache is byte-identical whether the studio
  // installed no modules or the fetch never landed, so a caller that must NAME a module cannot tell
  // "this studio has no GPU door" from "I could not ask". Those refusals belong to different parties
  // and read differently to a user. Answered by the shared memo now, with the same meaning: false
  // before any load, false on success, true only when a load COMPLETED without the projection.
  function registryUnavailable() {
    return registry().registryUnavailable();
  }

  function byName(data) {
    return Object.fromEntries((data.modules || []).map((m) => [m.name, m]));
  }

  function moduleLabel(mod) {
    if (!mod) return "";
    const l = mod.provides && mod.provides[0] && mod.provides[0].label;
    return (l && String(l).trim()) || mod.name;
  }

  function hookModules(hook, filter) {
    if (!cache) return [];
    const order = cache.hooks && Array.isArray(cache.hooks[hook]) ? cache.hooks[hook] : [];
    const named = byName(cache);
    const mods = order.map((n) => named[n]).filter(Boolean);
    return filter ? mods.filter(filter) : mods;
  }

  function musicScoreModules() {
    return hookModules("score", (m) => m.config_schema && m.config_schema.prompt);
  }

  function narrationScoreModules() {
    return hookModules("score", (m) => m.config_schema && m.config_schema.text);
  }

  function beatSyncScoreModules() {
    return hookModules("score", (m) => m.config_schema && m.config_schema.clip_seconds);
  }

  function motionBackendModules() {
    return hookModules("motion.backend");
  }

  // Wan LoRA motion is the module whose schema carries the dual expert LoRA lists.
  // Keyed on capability (config_schema), never on a compiled module name (cf#474).
  function isWanLoraMotion(mod) {
    const schema = mod && mod.config_schema;
    return !!(schema && schema.high_noise_loras && schema.low_noise_loras);
  }

  // Classify a motion.backend module's locality from its manifest ui.locality hint. Three values:
  //   "local" -- a genuinely local consumer GPU (a homelab card).
  //   "byo"   -- your-own-RunPod-endpoint (BYO keys); the own-gpu module, which backs the
  //              server-side CONTRACT-2.27 finalize route. NOT a homelab card -- badging it
  //              "Local (your GPU)" would be dishonest.
  //   "cloud" -- a rented datacenter i2v model.
  // Prefer the manifest hint (a projection of the registry, the right source of truth); FALL BACK
  // to the legacy name check ("own-gpu" was the BYO default door) -> "byo" ONLY when a module does
  // not declare ui.locality, so classification is byte-identical during the rollout window while
  // the motion.backend manifests gain ui.locality. The "datacenter" alias maps to cloud.
  // REMOVE the name-check fallback once every motion.backend manifest carries ui.locality
  // (final cleanup -- a later follow-up).
  function motionLocality(mod) {
    const loc = mod && mod.ui && typeof mod.ui.locality === "string"
      ? mod.ui.locality.trim().toLowerCase()
      : "";
    if (loc === "local") return "local";
    if (loc === "byo") return "byo";
    if (loc === "cloud" || loc === "datacenter") return "cloud";
    return mod && mod.name === "own-gpu" ? "byo" : "cloud"; // legacy fallback (removable)
  }

  // The GPU-finalize door: bound to the BYO module (own-gpu) SPECIFICALLY. Keying on "byo" (NOT
  // generic "local") means a new homelab "local" door is fully selectable for motion yet can never
  // hijack the finalize route's default. Name kept ownGpuModule for caller compat.
  //
  // cf#347: this comment used to say the finalize route "is hardcoded to motion backend own-gpu".
  // That was already false when cf#347 was filed -- the route RESOLVED a door rather than
  // hardcoding one -- and PR #421 moved it further: src/finalize-from-keyframes.ts:186 now reads
  //   motionBackend = args.motionBackend ?? mapped.motion_backend ?? gpuDoor;
  // so an explicit caller choice wins, the parent row's stored override is the fallback, and this
  // byo door is only the LAST resort. A stale comment in a live path is what sent the crew hunting
  // a non-existent bundle defect (vivijure-core#122); corrected rather than left to do it again.
  function ownGpuModule() {
    return motionBackendModules().find((m) => motionLocality(m) === "byo") || null;
  }

  // Cloud i2v doors (the animate-cloud / hybrid model picker): datacenter-rented backends only.
  // Excludes byo (the own-gpu finalize door) and local (the homelab door, which the main render
  // backend selector surfaces directly, not via this cloud picker).
  function cloudMotionModules() {
    return motionBackendModules().filter((m) => motionLocality(m) === "cloud");
  }

  // The gpu-door SET: motion backends that run on hardware the operator controls (byo or local),
  // mirroring the core's gpuDoorMotionModules. Cloud backends are excluded.
  function gpuDoorMotionModules() {
    return motionBackendModules().filter((m) => {
      const l = motionLocality(m);
      return l === "byo" || l === "local";
    });
  }

  // The door a render lands on when it names none, mirroring the core's defaultGpuDoorModule:
  // the byo door if one is installed, else the first gpu door in serving order (a local door is
  // normally an explicit pick, so it becomes the default only when it is the ONLY gpu door).
  //
  // This exists so the panel can send an EXPLICIT motion_backend instead of letting the door pick
  // for it (cf#344). Mirroring rather than inventing is the point: on every host where the core
  // would have resolved a door, the panel now NAMES that same door, so making the choice explicit
  // is not a behaviour change. Null when no gpu door is installed -- the caller then sends no
  // backend at all rather than inventing a name, and the core refuses honestly.
  //
  // One host shape where this and the core disagree, stated because it is not visible from here:
  // a motion.backend module that declares no ui.locality. The core counts it as neither byo nor
  // local and so excludes it from the gpu-door set; motionLocality() above still maps a module
  // NAMED own-gpu to byo during the rollout window. There the panel names a door the core would
  // not have defaulted to, which the core's own preflight accepts (it is installed and serving)
  // and which is strictly better than sending nothing. That fallback and this note retire
  // together, once every motion.backend manifest carries ui.locality.
  function defaultGpuDoorModule() {
    const doors = gpuDoorMotionModules();
    return doors.find((m) => motionLocality(m) === "byo") || doors[0] || null;
  }

  function planEnhanceInstalled() {
    return hookModules("plan.enhance").length > 0;
  }

  function cloudModelLabel(id) {
    const hit = motionBackendModules().find((m) => m.name === id);
    if (hit) return moduleLabel(hit);
    // legacy rows may still carry Workers-AI-style model ids from the monolith era
    if (id && String(id).includes("/")) return String(id).split("/").pop();
    return id ? String(id) : "";
  }

  function cloudModelOptions() {
    return cloudMotionModules().map((m) => [m.name, moduleLabel(m)]);
  }

  function gpuMotionLabel() {
    const m = ownGpuModule();
    return m ? moduleLabel(m) : "GPU i2v";
  }

  // The keyframe hook is pick_one; the planner default is the ui.order-first serving module. Its
  // manifest keyframe_label is the compact display token for the keyframe-stage backend/model (e.g.
  // "SDXL"), which the planner projects inline instead of hardcoding the model name. First serving
  // module that declares one wins; fall back to "SDXL" (the GPU keyframe default) when none is
  // declared, so the copy is never blank.
  function keyframeLabel() {
    for (const m of hookModules("keyframe")) {
      const l = m && typeof m.keyframe_label === "string" && m.keyframe_label.trim();
      if (l) return l;
    }
    return "SDXL";
  }

  global.plannerRegistry = {
    load,
    registryUnavailable,
    moduleLabel,
    musicScoreModules,
    narrationScoreModules,
    beatSyncScoreModules,
    motionBackendModules,
    isWanLoraMotion,
    ownGpuModule,
    gpuDoorMotionModules,
    defaultGpuDoorModule,
    cloudMotionModules,
    planEnhanceInstalled,
    cloudModelLabel,
    cloudModelOptions,
    gpuMotionLabel,
    keyframeLabel,
  };
})(window);
