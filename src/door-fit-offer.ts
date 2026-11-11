// vivijure-cf#930: the doors a film offers core for a per-shot door fit. Conrad's ruling (2026-11-11): a
// per-shot motion door applies to that one clip only, and the film's door stays the default for every
// other shot. Core decides, per lined shot and after the lines are bought, whether the film door's clip
// floor would leave the speaker mouthing silence; if so it moves that one shot to the first door offered
// here that takes it without a tail (core door-fit.ts). This module only builds the offer.

import { servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { prepareSpokenClip } from "./motion-scatter";

/** Whether a film door the CALLER named may still have a shot moved off it. A door the caller set on a
 *  SHOT is never moved either way; that is core's rule, not this one. */
// Conrad's ruling on vivijure-cf#930 (2026-11-11): B. An explicit film door is the default for every
// shot, and a short-line shot may still move off it for that one clip.
export const DOOR_FIT_FOR_EXPLICIT_FILM_DOOR = true;

export interface DoorFitOffer {
  /** In order of preference; absent when nothing is offered. */
  door_fit?: string[];
  /** Each offered door's config, prepared as the film path prepares its own door for spoken lines. */
  motion_configs?: Record<string, Record<string, unknown>>;
}

function locality(m: RegisteredModule | undefined): unknown {
  return (m?.ui as { locality?: unknown } | undefined)?.locality;
}

/** The offer for a film rendering on `filmDoor`. Empty unless the film has lines, the film door is driven
 *  by audio (only such a door can leave a tail), and the door was not the caller's own choice (unless
 *  DOOR_FIT_FOR_EXPLICIT_FILM_DOOR). Offered: every other serving driven motion door with the film door's
 *  locality, so a cloud film never moves a shot to a local GPU or the other way round, in ui.order, each
 *  with the config prepareSpokenClip gives it. */
export function doorFitOffer(
  modules: RegisteredModule[],
  filmDoor: string | undefined,
  opts: { spoken: boolean; explicit: boolean },
): DoorFitOffer {
  if (!opts.spoken || !filmDoor) return {};
  if (opts.explicit && !DOOR_FIT_FOR_EXPLICIT_FILM_DOOR) return {};
  const serving = servingForHook(modules, "motion.backend");
  const film = serving.find((m) => m.name === filmDoor);
  if (!film || film.usage?.driving_audio !== true) return {};
  const names: string[] = [];
  const configs: Record<string, Record<string, unknown>> = {};
  for (const m of serving) {
    if (m.name === filmDoor || m.usage?.driving_audio !== true || locality(m) !== locality(film)) continue;
    const clip = prepareSpokenClip(modules, m, {}, undefined, true);
    if (!clip.ok) continue;
    names.push(m.name);
    configs[m.name] = clip.config ?? {};
  }
  return names.length ? { door_fit: names, motion_configs: configs } : {};
}
