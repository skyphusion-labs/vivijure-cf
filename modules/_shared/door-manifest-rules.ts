// cf#1246: the rules every motion.backend manifest must meet for the panel to total a film and grade its faces.
// ONE place. tests/motion-door-price-face-1246.test.ts runs it over every motion door it finds in modules/, so a
// new door cannot skip it, and over planted fixtures, so each refusal is shown to fire.
//
// Pure and dependency-free. A refusal is a sentence naming the field, never a value from the manifest's prose.

export const FACE_HOLD_VALUES = ["drift", "one", "two", "hold"] as const;

const AS_OF = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLIP_KEYS = new Set(["usd", "resolution", "seconds"]);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A real calendar day in YYYY-MM-DD, and not after `today`. */
function validAsOf(v: unknown, today: string): boolean {
  if (typeof v !== "string") return false;
  const m = AS_OF.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
  return v <= today;
}

/** The door's resolution enum values, from `resolution` or `size`, or null when it has no such knob. */
function resolutionValues(m: Rec): string[] | null {
  const schema = isRec(m.config_schema) ? m.config_schema : {};
  for (const k of ["resolution", "size"]) {
    const f = schema[k];
    if (isRec(f) && f.type === "enum" && Array.isArray(f.values)) return f.values.filter((x): x is string => typeof x === "string");
  }
  return null;
}

/** Every reason this manifest fails the cf#1246 rules. Empty means it passes. Only motion.backend doors are judged.
 *  `today` is YYYY-MM-DD, injectable so a test is not tied to the clock. */
export function motionDoorRefusals(manifest: unknown, today = new Date().toISOString().slice(0, 10)): string[] {
  if (!isRec(manifest)) return ["manifest is not an object"];
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  if (!hooks.includes("motion.backend")) return [];
  const out: string[] = [];
  const usage = isRec(manifest.usage) ? manifest.usage : null;
  const ui = isRec(manifest.ui) ? manifest.ui : {};

  if (!usage || usage.face_hold === undefined) out.push("usage.face_hold is missing");
  else if (!(FACE_HOLD_VALUES as readonly unknown[]).includes(usage.face_hold)) {
    out.push(`usage.face_hold must be one of ${FACE_HOLD_VALUES.join(", ")}`);
  }

  const ps = ui.cost_usd_per_second;
  const pc = ui.cost_usd_per_clip;
  if (ps !== undefined && pc !== undefined) out.push("ui carries both cost_usd_per_second and cost_usd_per_clip");

  if (ps !== undefined) {
    if (!Array.isArray(ps) || ps.length !== 2 || !positive(ps[0]) || !positive(ps[1])) {
      out.push("ui.cost_usd_per_second must be [low, high], two positive numbers");
    } else if ((ps[1] as number) < (ps[0] as number)) {
      out.push("ui.cost_usd_per_second high is below low");
    }
  }

  if (pc !== undefined) {
    if (!Array.isArray(pc) || pc.length === 0) {
      out.push("ui.cost_usd_per_clip must be a non-empty array");
    } else {
      const res = resolutionValues(manifest);
      const steps = usage && Array.isArray(usage.duration_steps) ? usage.duration_steps : null;
      pc.forEach((p, i) => {
        if (!isRec(p)) { out.push(`ui.cost_usd_per_clip[${i}] is not an object`); return; }
        for (const k of Object.keys(p)) if (!CLIP_KEYS.has(k)) out.push(`ui.cost_usd_per_clip[${i}] has unknown key ${k}`);
        if (!positive(p.usd)) out.push(`ui.cost_usd_per_clip[${i}].usd must be a positive number`);
        if (p.resolution !== undefined && !(res ?? []).includes(p.resolution as string)) {
          out.push(`ui.cost_usd_per_clip[${i}].resolution is not a value of the door's resolution enum`);
        }
        if (p.seconds !== undefined && !(steps ?? []).includes(p.seconds)) {
          out.push(`ui.cost_usd_per_clip[${i}].seconds is not one of usage.duration_steps`);
        }
      });
    }
  }

  const priced = ps !== undefined || pc !== undefined;
  if (priced && ui.cost_as_of === undefined) out.push("a cost field needs ui.cost_as_of");
  if (ui.cost_as_of !== undefined) {
    if (!priced) out.push("ui.cost_as_of is set with no cost field");
    if (!validAsOf(ui.cost_as_of, today)) out.push("ui.cost_as_of must be a real day, YYYY-MM-DD, not in the future");
  }
  return out;
}
