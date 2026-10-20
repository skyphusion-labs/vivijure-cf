// Talking-door helpers for the film submit filter.

import { cloudMotionModules, servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { moduleLabel } from "./module-catalog";

type DoorShape = {
  name?: string;
  usage?: { native_audio?: boolean; driving_audio?: boolean };
  config_schema?: Record<string, unknown>;
};

/** driving_audio and not native_audio. InfiniteTalk. alibaba-wan is both, so it is not this. */
export function isDrivingOnlyDoor(mod: DoorShape | undefined): boolean {
  const usage = mod && mod.usage;
  return !!(usage && usage.driving_audio === true && usage.native_audio !== true);
}

/** Cloud motion that neither speaks natively nor consumes a line file. Hailuo is this shape. */
export function isSilentCatalogDoor(mod: DoorShape | undefined): boolean {
  const usage = mod && mod.usage;
  if (!usage) return false;
  return usage.native_audio !== true && usage.driving_audio !== true;
}

/** Hosted spoken default: installed infinitetalk when it is driving-only, else the first
 *  cloud driving-only door. own-gpu and alibaba-wan are not candidates. */
export function hostedSpokenDoor(modules: RegisteredModule[]): RegisteredModule | undefined {
  const driving = cloudMotionModules(modules).filter((m) => isDrivingOnlyDoor(m));
  return driving.find((m) => m.name === "infinitetalk") ?? driving[0];
}

/** Hosted silent default: the first cloud catalog door that does not speak. */
export function hostedSilentDoor(modules: RegisteredModule[]): RegisteredModule | undefined {
  return cloudMotionModules(modules).find((m) => isSilentCatalogDoor(m));
}

export function bundleScenesHaveLines(
  scenes: { dialogue?: { text?: string } | null }[] | undefined | null,
): boolean {
  if (!Array.isArray(scenes)) return false;
  return scenes.some((s) => {
    const text = s && s.dialogue && s.dialogue.text;
    return typeof text === "string" && text.trim().length > 0;
  });
}

/** Put the hosted door on an overrides bag so the pipeline resolves THAT module's config.
 *  The pipeline's own default is not a caller choice. */
export function withMotionBackend(overrides: unknown, name: string): Record<string, unknown> {
  const bag = overrides && typeof overrides === "object" && !Array.isArray(overrides)
    ? { ...(overrides as Record<string, unknown>) }
    : {};
  bag.motion_backend = name;
  return bag;
}

/** When the caller named no backend: spoken picks the driving-only cloud door, silent picks
 *  the catalog door. Neither falls through to own-gpu. */
export function hostedMotionFallback(
  modules: RegisteredModule[],
  explicit: string | undefined | null,
  spoken: boolean,
): { name: string } | { error: string } {
  const named = typeof explicit === "string" ? explicit.trim() : "";
  if (named) return { name: named };
  if (spoken) {
    const door = hostedSpokenDoor(modules);
    if (door) return { name: door.name };
    return { error: spokenLinesRefusalMessage(modules, undefined, true) };
  }
  const silent = hostedSilentDoor(modules);
  if (silent) return { name: silent.name };
  return { error: "no silent catalog motion.backend module is installed" };
}

/** A spoken shot on a driving-only door is the cast line. Accept it with native audio off,
 *  and do not attach a voice-sample clip. A native-audio door keeps the old refusal when
 *  talking audio is off. A door that cannot speak is still refused. */
export function prepareSpokenClip(
  modules: RegisteredModule[],
  mod: RegisteredModule | undefined,
  config: Record<string, unknown> | undefined,
  voiceRefs: Record<string, string> | undefined,
  spoken: boolean,
): { ok: true; config: Record<string, unknown> | undefined; voiceRefs: Record<string, string> | undefined } | { ok: false; error: string } {
  if (!spoken) return { ok: true, config, voiceRefs };
  if (isDrivingOnlyDoor(mod)) {
    const schema = mod && mod.config_schema;
    const next = schema && Object.prototype.hasOwnProperty.call(schema, "generate_audio")
      ? { ...(config ?? {}), generate_audio: false }
      : config;
    return { ok: true, config: next, voiceRefs: undefined };
  }
  const audioOn = generateAudioOn(config as Record<string, unknown> | undefined);
  if (!doorCanSpeakLines(mod) || !audioOn) {
    return { ok: false, error: spokenLinesRefusalMessage(modules, mod, audioOn) };
  }
  return { ok: true, config, voiceRefs };
}

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

/** The installed motion.backend doors that can speak a line, in the registry's own display order.
 *
 *  cf#919: the REMEDY a refusal offers is now projected from the same module set the guard reads one
 *  line above it. It used to be a literal naming seven doors, which meant a hosted filmmaker was sent
 *  to look for InfiniteTalk -- a door that is not in the hosted tenant catalog and cannot be installed
 *  there. A literal also cannot go red: no module set could falsify it, which is why it stayed wrong
 *  while the predicate beside it was correct. */
export function talkingDoorLabels(modules: RegisteredModule[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mod of servingForHook(modules, "motion.backend")) {
    if (!doorCanSpeakLines(mod)) continue;
    const label = moduleLabel(mod);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function joinDoors(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return labels.slice(0, -1).join(", ") + " or " + labels[labels.length - 1];
}

/** The refusal for a storyboard with spoken lines that this render cannot say.
 *
 *  The guard is (door cannot speak) OR (talking audio switched off), and one literal served both, so a
 *  filmmaker who had already picked the right door was told to go pick a different one. Three states,
 *  three sentences, and the door list in the third is projected, never authored. */
export function spokenLinesRefusalMessage(
  modules: RegisteredModule[],
  chosen: RegisteredModule | undefined,
  audioOn: boolean,
): string {
  if (chosen && doorCanSpeakLines(chosen) && !audioOn) {
    return `This storyboard has spoken lines, and talking audio is switched off on ${moduleLabel(chosen)}. Turn talking audio back on, or clear the spoken lines.`;
  }
  const labels = talkingDoorLabels(modules);
  if (labels.length === 0) {
    return "This storyboard has spoken lines, and this studio has no talking door installed. Every motion door installed here is a silent look door, which cannot say the script. Install a talking door, or clear the spoken lines.";
  }
  return `This storyboard has spoken lines. Pick a talking door (${joinDoors(labels)}) and leave talking audio on. Silent look doors cannot say the script.`;
}

/** Native-AV or driving-audio door: it can speak our keyframe using the storyboard script. */
export function doorCanSpeakLines(
  mod: { usage?: { native_audio?: boolean; driving_audio?: boolean } } | undefined,
): boolean {
  const usage = mod && mod.usage;
  return !!(usage && (usage.native_audio === true || usage.driving_audio === true));
}
