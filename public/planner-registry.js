// Planner module registry: one fetch of GET /api/modules, shared helpers for every
// self-assembling control in the planner. No feature names or providers are
// hardcoded here -- only hook names from the vivijure-module/2 contract.
(function (global) {
  let cache = null;
  let loadPromise = null;
  // cf#344: did the projection actually ARRIVE?
  //
  // load() resolves on failure with an EMPTY registry rather than rejecting, which keeps every
  // read-only control degrading quietly. That is right for a label and wrong for a decision: an
  // empty cache is byte-identical whether the studio installed no modules or the fetch never
  // landed, so a caller that must NAME a module cannot tell "this studio has no GPU door" from
  // "I could not ask". Those refusals belong to different parties and read differently to a user.
  //
  // Tracked separately rather than by changing load()'s contract, so no existing reader's behaviour
  // moves: they still see the empty shape and still degrade exactly as before.
  let loadFailed = false;

  function load() {
    if (cache) return Promise.resolve(cache);
    if (!loadPromise) {
      loadPromise = fetch("/api/modules")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) loadFailed = true;
          cache = d || { modules: [], hooks: {}, catalog: [] };
          return cache;
        })
        .catch(() => {
          loadFailed = true;
          cache = { modules: [], hooks: {}, catalog: [] };
          return cache;
        });
    }
    return loadPromise;
  }

  // True only when a load COMPLETED and could not deliver the projection (non-ok response or a
  // transport failure). False before any load and false on a successful one, so a caller must
  // await load() first -- reading it early answers about a question that has not been asked yet.
  function registryUnavailable() {
    return loadFailed;
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

  // The GPU-finalize door: bound to the BYO module (own-gpu) SPECIFICALLY, because it gates the
  // server-side CONTRACT-2.27 finalize route, which is hardcoded to motion backend own-gpu. Keying
  // on "byo" (NOT generic "local") means a new homelab "local" door is fully selectable for motion
  // yet can never hijack the own-gpu finalize route. Name kept ownGpuModule for caller compat.
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
