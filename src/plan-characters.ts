// cf#1137: the shape of `characters` on POST /api/storyboard/plan, checked at the door.
//
// The route only checked that `characters` was an array. Core's buildPlanningUserMessage then sorted
// the entries with `a.slot.localeCompare(b.slot)`, so a caller that sent `{ name, description }` (no
// slot) got a 500 "internal error" instead of being told what the field needs. This names the three
// fields every entry must carry, and says which entry is wrong.
//
// The rule matches what both panel callers already send (planner-cast.js collectCast, make.js
// characters): `slot` is one of the four slot ids, `name` is a non-empty string, and `bible` is a
// string that may be empty (a cast member with no description is allowed).
import { SLOT_IDS } from "@skyphusion-labs/vivijure-core/storyboard-validate";

export const PLAN_CHARACTER_SHAPE =
  "each characters entry needs slot (one of " + SLOT_IDS.join(", ") + "), name (a non-empty string) and bible (a string, may be empty)";

/** The refusal message for a bad `characters` value, or null when it is usable. Absent or null is
 *  usable (the route defaults it to an empty cast, #143). Only field NAMES are echoed, never values. */
export function planCharactersRefusal(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return "characters must be an array; " + PLAN_CHARACTER_SHAPE;
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      return `characters[${i}] is not an object; ${PLAN_CHARACTER_SHAPE}`;
    }
    const o = c as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof o.slot !== "string" || !(SLOT_IDS as readonly string[]).includes(o.slot)) bad.push("slot");
    if (typeof o.name !== "string" || o.name.trim() === "") bad.push("name");
    if (typeof o.bible !== "string") bad.push("bible");
    if (bad.length) {
      const keys = Object.keys(o).slice(0, 10).join(", ") || "none";
      return `characters[${i}] is missing or has a bad ${bad.join(", ")} (fields sent: ${keys}); ${PLAN_CHARACTER_SHAPE}`;
    }
    if (seen.has(o.slot as string)) return `characters[${i}] repeats slot ${String(o.slot)}; each slot may appear once`;
    seen.add(o.slot as string);
  }
  return null;
}
