import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { faceGrade, GRADE } from "../public/make-style.js";
import { FACE_HOLD_VALUES, motionDoorRefusals } from "../modules/_shared/door-manifest-rules";

// cf#1246: every motion door states what a clip costs us, the day that cost was read, and how well it holds a
// face. The rules live in ONE place (modules/_shared/door-manifest-rules.ts). This file runs them over every
// motion door in modules/, found by loading each module's own module.json, so a new door cannot skip them,
// and over planted fixtures, so each refusal is shown to fire.

type Worker = { fetch(req: Request, env: never, ctx: never): Promise<Response> };
type Manifest = {
  name: string;
  hooks: string[];
  ui?: { cost?: string; cost_usd_per_second?: unknown; cost_usd_per_clip?: unknown; cost_as_of?: string; limits?: string[] };
  usage?: Record<string, unknown> & { face_hold?: string };
};

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "modules");
const MODULE_DIRS = readdirSync(MODULES_DIR).filter((d) => existsSync(join(MODULES_DIR, d, "src", "index.ts")));

async function allManifests(): Promise<{ dir: string; m: Manifest | null; err?: string }[]> {
  const out = [];
  for (const dir of MODULE_DIRS) {
    try {
      const mod = (await import(`../modules/${dir}/src/index.ts`)) as { default?: Worker };
      if (!mod.default || typeof mod.default.fetch !== "function") { out.push({ dir, m: null, err: "no default worker" }); continue; }
      const res = await mod.default.fetch(new Request("https://m/module.json"), {} as never, {} as never);
      out.push({ dir, m: (await res.json()) as Manifest });
    } catch (e) {
      out.push({ dir, m: null, err: String(e) });
    }
  }
  return out;
}

// A metered door with no price says why. Anything else must carry one, so dropping a price goes red here.
const UNPRICED: Record<string, string> = {
  "cf-seedance": "the Cloudflare model page lists no price",
  "local-gpu": "the user's own hardware",
  "own-gpu": "GPU seconds on our endpoint, not a listed price",
};

describe("every motion door in modules/ meets the cf#1246 rules", async () => {
  const found = await allManifests();
  const doors = found.filter((f) => f.m && f.m.hooks.includes("motion.backend")) as { dir: string; m: Manifest }[];

  it("finds the motion doors, and every module answers module.json", () => {
    // The denominator, printed: a discovery that silently found nothing would pass every check below.
    expect(found.length).toBeGreaterThan(30);
    expect(found.filter((f) => !f.m).map((f) => `${f.dir}: ${f.err}`)).toEqual([]);
    expect(doors.length).toBeGreaterThanOrEqual(16);
  });

  for (const name of [
    "alibaba-wan", "alibaba-wan-lora", "cf-flux-3-video", "cf-grok-video", "cf-hailuo", "cf-hh1-r2v", "cf-kling-v4",
    "cf-minimax-h3", "cf-p-video-avatar", "cf-seedance", "cf-veo", "cf-vidu-q3-turbo", "infinitetalk", "local-gpu",
    "minimax-hailuo", "own-gpu",
  ]) {
    it(`${name} is discovered as a motion door`, () => {
      expect(doors.map((d) => d.m.name)).toContain(name);
    });
  }

  it("no motion door is refused by the rules", () => {
    const refused = doors.map((d) => ({ door: d.m.name, why: motionDoorRefusals(d.m) })).filter((r) => r.why.length);
    expect(refused).toEqual([]);
  });

  it("every metered motion door carries a price, or is named as unpriced with a reason", () => {
    const unpricedFound = doors
      .filter((d) => d.m.ui?.cost_usd_per_second === undefined && d.m.ui?.cost_usd_per_clip === undefined)
      .map((d) => d.m.name)
      .sort();
    expect(unpricedFound).toEqual(Object.keys(UNPRICED).sort());
    for (const why of Object.values(UNPRICED)) expect(why.length).toBeGreaterThan(0);
  });

  it("a priced door does not still say only 'Pay per render'", () => {
    const vague = doors.filter((d) => d.m.ui?.cost_as_of !== undefined && d.m.ui?.cost === "Pay per render");
    expect(vague.map((d) => d.m.name)).toEqual([]);
  });

  it("an unpriced metered door says so in its own limits", () => {
    const seedance = doors.find((d) => d.m.name === "cf-seedance")!;
    expect((seedance.m.ui?.limits ?? []).some((l) => /no price/i.test(l))).toBe(true);
  });

  // make-style.js reads usage.face_hold now (cf#1246), so comparing the field with faceGrade would
  // compare it with itself and could not fail. The proof the switch changed no door's grade is the
  // rule the panel used BEFORE, frozen here from main at 5a96dff (its FACE_EVIDENCE table plus the
  // generic facts), run on every real manifest: it must give the declared grade, and so must the panel.
  const OLD_FACE_EVIDENCE: Record<string, number> = { "alibaba-wan-lora": 3, "cf-hh1-r2v": 3, "cf-flux-3-video": 0 };
  const oldFaceGrade = (m: { name: string; usage?: Record<string, unknown> }): number => {
    if (m.name in OLD_FACE_EVIDENCE) return OLD_FACE_EVIDENCE[m.name];
    const u = m.usage ?? {};
    if (u.driving_audio === true && u.native_audio !== true) return 3;
    return u.first_last === true ? 2 : 1;
  };

  it("face_hold is the grade the old rule gave, and the panel now reads it", () => {
    const off = doors
      .map((d) => ({
        door: d.m.name,
        declared: d.m.usage?.face_hold,
        old: FACE_HOLD_VALUES[oldFaceGrade(d.m as never)],
        panel: FACE_HOLD_VALUES[faceGrade(d.m as never)],
      }))
      .filter((r) => r.declared !== r.old || r.panel !== r.old);
    expect(off).toEqual([]);
  });

  it("the face grades use the panel's own scale, and the old rule's evidence names real doors", () => {
    expect(FACE_HOLD_VALUES.map((_, i) => i)).toEqual([GRADE.DRIFT, GRADE.ONE, GRADE.TWO, GRADE.HOLD]);
    for (const n of Object.keys(OLD_FACE_EVIDENCE)) expect(doors.map((d) => d.m.name)).toContain(n);
  });
});

// Each refusal, planted on a door that otherwise passes. A rule that cannot be shown to fire is decoration.
describe("motionDoorRefusals refuses each broken shape", () => {
  const TODAY = "2026-11-05";
  const good = () => ({
    name: "d", hooks: ["motion.backend"],
    config_schema: { resolution: { type: "enum", values: ["720p", "1080p"], default: "720p" } },
    ui: { cost: "$x", cost_as_of: "2026-11-05", cost_usd_per_second: [0.1, 0.2] as unknown },
    usage: { face_hold: "one", native_audio: false, voice: "cast_tts", scatter_native_audio: false, min_seconds: 5,
             max_seconds: 10, duration_steps: [5, 10] } as Record<string, unknown>,
  });
  const perClip = (entries: unknown) => {
    const m = good();
    delete (m.ui as Record<string, unknown>).cost_usd_per_second;
    (m.ui as Record<string, unknown>).cost_usd_per_clip = entries;
    return m;
  };
  const refuses = (m: unknown, re: RegExp) => {
    const why = motionDoorRefusals(m, TODAY);
    expect(why.some((w) => re.test(w)), JSON.stringify(why)).toBe(true);
  };

  it("CONTROL: a well-formed per-second door passes", () => expect(motionDoorRefusals(good(), TODAY)).toEqual([]));
  it("CONTROL: a well-formed per-clip door passes", () => {
    expect(motionDoorRefusals(perClip([{ resolution: "720p", seconds: 5, usd: 0.3 }, { usd: 0.5 }]), TODAY)).toEqual([]);
  });
  it("CONTROL: an unpriced door with a grade passes", () => {
    const m = good();
    m.ui = { cost: "x" } as never;
    expect(motionDoorRefusals(m, TODAY)).toEqual([]);
  });
  it("CONTROL: a module that is not a motion door is not judged", () => {
    expect(motionDoorRefusals({ name: "k", hooks: ["keyframe"] }, TODAY)).toEqual([]);
  });

  it("missing face_hold", () => { const m = good(); delete m.usage.face_hold; refuses(m, /face_hold is missing/); });
  it("no usage at all", () => { const m = good() as Record<string, unknown>; delete m.usage; refuses(m, /face_hold is missing/); });
  it("unknown face_hold", () => { const m = good(); m.usage.face_hold = "good"; refuses(m, /face_hold must be one of/); });
  it("both cost fields", () => {
    const m = good();
    (m.ui as Record<string, unknown>).cost_usd_per_clip = [{ usd: 1 }];
    refuses(m, /both cost_usd_per_second and cost_usd_per_clip/);
  });
  it("per-second not a pair", () => { const m = good(); m.ui.cost_usd_per_second = [0.1]; refuses(m, /two positive numbers/); });
  it("per-second zero", () => { const m = good(); m.ui.cost_usd_per_second = [0, 0.2]; refuses(m, /two positive numbers/); });
  it("per-second high below low", () => { const m = good(); m.ui.cost_usd_per_second = [0.2, 0.1]; refuses(m, /high is below low/); });
  it("per-clip empty", () => refuses(perClip([]), /non-empty array/));
  it("per-clip not an array", () => refuses(perClip({ usd: 1 }), /non-empty array/));
  it("per-clip entry not an object", () => refuses(perClip([0.3]), /\[0\] is not an object/));
  it("per-clip usd missing", () => refuses(perClip([{ seconds: 5 }]), /\.usd must be a positive number/));
  it("per-clip usd negative", () => refuses(perClip([{ usd: -1 }]), /\.usd must be a positive number/));
  it("per-clip resolution not in the enum", () => refuses(perClip([{ usd: 1, resolution: "4k" }]), /resolution enum/));
  it("per-clip seconds not a duration step", () => refuses(perClip([{ usd: 1, seconds: 8 }]), /duration_steps/));
  it("per-clip unknown key", () => refuses(perClip([{ usd: 1, secs: 5 }]), /unknown key secs/));
  it("cost field without cost_as_of", () => { const m = good(); delete (m.ui as Record<string, unknown>).cost_as_of; refuses(m, /needs ui.cost_as_of/); });
  it("cost_as_of not a date", () => { const m = good(); m.ui.cost_as_of = "Nov 5"; refuses(m, /YYYY-MM-DD/); });
  it("cost_as_of not a real day", () => { const m = good(); m.ui.cost_as_of = "2026-02-30"; refuses(m, /YYYY-MM-DD/); });
  it("cost_as_of in the future", () => { const m = good(); m.ui.cost_as_of = "2026-11-06"; refuses(m, /not in the future/); });
  it("cost_as_of with no cost field", () => {
    const m = good();
    delete (m.ui as Record<string, unknown>).cost_usd_per_second;
    refuses(m, /cost_as_of is set with no cost field/);
  });
});
