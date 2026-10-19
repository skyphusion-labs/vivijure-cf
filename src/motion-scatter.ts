// Talking-door helpers for the film submit filter.

import { servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { moduleLabel } from "./module-catalog";

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
