// Scatter is for silent cloud drafts. Talking clips and the look doors
// (own-gpu / local-gpu) stay on one film so voice and face can hold.

const LOOK_DOORS = new Set(["own-gpu", "local-gpu"]);

export function generateAudioOn(config: Record<string, unknown> | undefined): boolean {
  if (!config) return true;
  return config.generate_audio !== false;
}

export function isTalkingClip(
  mod: { name?: string; usage?: { native_audio?: boolean } } | undefined,
  generateAudio: boolean,
): boolean {
  const usage = mod && mod.usage;
  if (!usage || usage.native_audio !== true) return false;
  if (!generateAudio) return false;
  return true;
}

/** True when the storyboard (or explicit dialogue_lines) has at least one spoken line. */
export function spokenLinesPresent(
  lines: { text?: string }[] | undefined | null,
): boolean {
  if (!Array.isArray(lines)) return false;
  return lines.some((l) => l && typeof l.text === "string" && l.text.trim().length > 0);
}

/** Native-AV door: it can speak our keyframe using the storyboard script. */
export function doorCanSpeakLines(
  mod: { usage?: { native_audio?: boolean } } | undefined,
): boolean {
  return !!(mod && mod.usage && mod.usage.native_audio === true);
}

export function talkingScatterAllowed(
  mod: { name?: string; usage?: { native_audio?: boolean; scatter_native_audio?: boolean } } | undefined,
  generateAudio: boolean,
): boolean {
  if (isTalkingClip(mod, generateAudio)) return false;
  const name = mod && mod.name;
  if (name && LOOK_DOORS.has(name)) return false;
  const usage = mod && mod.usage;
  if (usage && usage.scatter_native_audio === false) return false;
  return true;
}
