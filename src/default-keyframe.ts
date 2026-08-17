// Fastest stills path: omitted keyframe_backend becomes cloud-keyframe when that
// module is installed. Explicit pick wins. local-gpu stays coupled in core
// (vivijure-local#153) and must not be redirected here.

export function withFastestKeyframeDefault(
  overrides: unknown,
  modules: ReadonlyArray<{ name: string }>,
): unknown {
  if (!modules.some((m) => m.name === "cloud-keyframe")) return overrides;
  const bag =
    overrides && typeof overrides === "object" && !Array.isArray(overrides)
      ? { ...(overrides as Record<string, unknown>) }
      : {};
  const motion = typeof bag.motion_backend === "string" ? bag.motion_backend.trim() : "";
  if (motion === "local-gpu") return overrides;
  const existing = typeof bag.keyframe_backend === "string" ? bag.keyframe_backend.trim() : "";
  if (existing) return overrides;
  bag.keyframe_backend = "cloud-keyframe";
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
  if (modules.some((m) => m.name === "cloud-keyframe")) return "cloud-keyframe";
  return keyframeBackend;
}
