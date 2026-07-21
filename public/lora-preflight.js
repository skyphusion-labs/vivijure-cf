// Pure helpers for the render-page LoRA training preflight (v0.221.0).
//
// These have NO DOM access on purpose: they unit-test under plain Node
// (tests/lora-preflight.test.ts) and also load as a classic <script> on
// planner.html, exposing `window.loraPreflight`. The UMD-ish wrapper picks
// CommonJS when `module` exists (the test harness) and a global otherwise
// (the browser), so the same file serves both with no build step.
//
// Why this exists: a bound character whose LoRA is not trained-and-ready gets
// its LoRA RETRAINED inline (~20 min) on EVERY render via the server fail-safe.
// That used to fire silently. The preflight reads FRESH cast state right before
// submit and warns when any bound slot will trigger the retrain tax.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.loraPreflight = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var WAN_LORA_BACKEND = "alibaba-wan-lora";

  // A cast member's LoRA is reusable (the GPU skips training) only when the
  // canonical training finished: lora_status === 'ready' AND the adapter keys
  // resolve for the chosen motion backend. This mirrors resolveCastLoras in core
  // (cast-loras.ts): SDXL lora_key wins on any backend; Wan renders need both
  // wan_lora_key_high and wan_lora_key_low when motion_backend is alibaba-wan-lora.
  function isCastLoraReady(cast, options) {
    if (!cast || cast.lora_status !== "ready") return false;
    var motionBackend =
      options && options.motionBackend ? String(options.motionBackend).trim() : "";
    var sdxlKey =
      cast.lora_key && String(cast.lora_key).indexOf("loras/") === 0 ? cast.lora_key : null;
    var wanHigh =
      cast.wan_lora_key_high && String(cast.wan_lora_key_high).indexOf("loras/") === 0
        ? cast.wan_lora_key_high
        : null;
    var wanLow =
      cast.wan_lora_key_low && String(cast.wan_lora_key_low).indexOf("loras/") === 0
        ? cast.wan_lora_key_low
        : null;
    if (sdxlKey) return true;
    if (motionBackend === WAN_LORA_BACKEND) {
      return !!(wanHigh && wanLow);
    }
    return false;
  }

  // Given the planner's {slot: cast_id} bindings and the current cast catalog
  // (rows from /api/cast, incl. lora_status + lora_key + wan_lora_key_*), return
  // the bound slots whose LoRA is NOT ready -- i.e. the ones that will be retrained
  // inline. Each entry is { slot, castId, name }, sorted by slot for a stable warning.
  // Unknown cast ids (not in the catalog) are skipped: a deleted member is
  // reconciled out of the bindings elsewhere, so flagging it here would be noise.
  //
  // S9 (F13): a cast id is an opaque public id (UUID string), never a number.
  // Keys and binding values are compared as verbatim strings -- no Number()
  // coercion, which would map every UUID to NaN and silently empty the warning.
  //
  // options.motionBackend: when alibaba-wan-lora, Wan dual keys satisfy readiness;
  // otherwise SDXL lora_key is required (mirrors server resolveCastLoras).
  function unreadyBoundLoraSlots(bindings, catalog, options) {
    const byId = new Map();
    for (const c of catalog || []) {
      if (c && c.id != null) byId.set(String(c.id), c);
    }
    const out = [];
    for (const slot of Object.keys(bindings || {})) {
      if (typeof slot !== "string" || slot.length === 0) continue;
      const id = bindings[slot];
      if (typeof id !== "string" || id.length === 0) continue;
      const cast = byId.get(id);
      if (!cast) continue;
      if (!isCastLoraReady(cast, options)) {
        out.push({ slot, castId: id, name: (cast.name && String(cast.name)) || ("slot " + slot) });
      }
    }
    out.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    return out;
  }

  // Stable identity for a set of unready slots, so the UI can tell whether the
  // user is re-clicking render against the SAME warning (proceed) or a changed
  // one (warn again).
  function loraSlotSignature(unready) {
    return (unready || [])
      .map((u) => u.slot + ":" + u.castId)
      .sort()
      .join("|");
  }

  return {
    isCastLoraReady,
    unreadyBoundLoraSlots,
    loraSlotSignature,
    WAN_LORA_BACKEND,
  };
});
