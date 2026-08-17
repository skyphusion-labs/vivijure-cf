// Hosted default stills path is GPU `keyframe` (own-gpu / vivijure-backend).
// Cloud-keyframe (RunPod Nano Banana 2) stays pickable. Explicit pick wins.
// local-gpu stays coupled in core (vivijure-local#153).

function defaultStillsName(modules: ReadonlyArray<{ name: string }>): string | undefined {
  if (modules.some((m) => m.name === "keyframe")) return "keyframe";
  if (modules.some((m) => m.name === "cloud-keyframe")) return "cloud-keyframe";
  return undefined;
}

export function withFastestKeyframeDefault(
  overrides: unknown,
  modules: ReadonlyArray<{ name: string }>,
): unknown {
  const pick = defaultStillsName(modules);
  if (!pick) return overrides;
  const bag =
    overrides && typeof overrides === "object" && !Array.isArray(overrides)
      ? { ...(overrides as Record<string, unknown>) }
      : {};
  const motion = typeof bag.motion_backend === "string" ? bag.motion_backend.trim() : "";
  if (motion === "local-gpu") return overrides;
  const existing = typeof bag.keyframe_backend === "string" ? bag.keyframe_backend.trim() : "";
  if (existing) return overrides;
  bag.keyframe_backend = pick;
  return bag;
}

export function defaultKeyframeBackendName(
  keyframeBackend: string | undefined,
  motionBackend: string | undefined,
  modules: ReadonlyArray<{ name: string }>,
): string | undefined {
  const existing = (keyframeBackend ?? "").trim();
  if (existing) return existing;
  if ((motionBackend ?? "").trim() === "local-gpu") return keyframeBackend;
  return defaultStillsName(modules) ?? keyframeBackend;
}
