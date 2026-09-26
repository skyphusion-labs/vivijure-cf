// Talking-door helpers for the film submit filter.

export function generateAudioOn(config: Record<string, unknown> | undefined): boolean {
  if (!config) return true;
  return config.generate_audio !== false;
}

export function isTalkingClip(
  mod: { name?: string; usage?: { native_audio?: boolean; driving_audio?: boolean } } | undefined,
  generateAudio: boolean,
): boolean {
  const usage = mod && mod.usage;
  if (!usage) return false;
  if (usage.native_audio !== true && usage.driving_audio !== true) return false;
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

/** Native-AV or driving-audio door: it can speak our keyframe using the storyboard script. */
export function doorCanSpeakLines(
  mod: { usage?: { native_audio?: boolean; driving_audio?: boolean } } | undefined,
): boolean {
  const usage = mod && mod.usage;
  return !!(usage && (usage.native_audio === true || usage.driving_audio === true));
}
