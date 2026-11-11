// vivijure-cf#1383, vivijure-cf#1387: core throws a TYPED refusal when a caller's input cannot be honoured. The studio
// answers it as a client error that names the problem, never as a 500. A route that does not reach this
// mapping turns a bad request into "internal error", which reads the same as a studio fault.
//
// One mapping, used by every catch that answers a route: the router (studio.ts) and the in-process door
// call the parent film makes (studio.ts callDoor). Adding a core refusal here covers both.
import { ConfigValueError } from "@skyphusion-labs/vivijure-core/modules/registry";
import { BoardKeyCollisionError } from "@skyphusion-labs/vivijure-core/storyboard-projects-db";

export interface CoreRefusal {
  status: number;
  error: string;
}

/** The client error for a refusal core threw, or null when `e` is not one. */
export function coreRefusal(e: unknown): CoreRefusal | null {
  // core#343: an enum value the module does not declare. The message names the field, the value and the
  // allowed set. It is refused before anything is spent, so 400 is the whole truth.
  if (e instanceof ConfigValueError) return { status: 400, error: e.message };
  // core#518 (core 1.43.0): another project already renders under this board's title key, so the two
  // would share stored keyframes and LoRAs. 409: the request is fine, it conflicts with what is stored.
  // The message names the holding project and the key, and asks for a different title.
  if (e instanceof BoardKeyCollisionError) return { status: 409, error: e.message };
  return null;
}
