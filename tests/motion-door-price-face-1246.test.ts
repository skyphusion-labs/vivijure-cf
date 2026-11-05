import { describe, it, expect } from "vitest";
import { faceGrade, GRADE, FACE_EVIDENCE } from "../public/make-style.js";
import alibabaWan from "../modules/alibaba-wan/src/index";
import alibabaWanLora from "../modules/alibaba-wan-lora/src/index";
import cfFlux3Video from "../modules/cf-flux-3-video/src/index";
import cfGrokVideo from "../modules/cf-grok-video/src/index";
import cfHailuo from "../modules/cf-hailuo/src/index";
import cfHh1R2v from "../modules/cf-hh1-r2v/src/index";
import cfKlingV4 from "../modules/cf-kling-v4/src/index";
import cfMinimaxH3 from "../modules/cf-minimax-h3/src/index";
import cfPVideoAvatar from "../modules/cf-p-video-avatar/src/index";
import cfSeedance from "../modules/cf-seedance/src/index";
import cfVeo from "../modules/cf-veo/src/index";
import cfViduQ3Turbo from "../modules/cf-vidu-q3-turbo/src/index";
import infinitetalk from "../modules/infinitetalk/src/index";
import localGpu from "../modules/local-gpu/src/index";
import minimaxHailuo from "../modules/minimax-hailuo/src/index";
import ownGpu from "../modules/own-gpu/src/index";

// cf#1246: every motion door states what a clip costs us and how well it holds a face, so the Make a video
// page totals a film and picks a face-consistent style from the manifests instead of from door names.
// Prices are provider cost with no markup (Conrad, 2026-11-05). Each manifest cites its source and date.

type Worker = { fetch(req: Request, env: never, ctx: never): Promise<Response> };
const DOORS: Record<string, Worker> = {
  "alibaba-wan": alibabaWan, "alibaba-wan-lora": alibabaWanLora, "cf-flux-3-video": cfFlux3Video,
  "cf-grok-video": cfGrokVideo, "cf-hailuo": cfHailuo, "cf-hh1-r2v": cfHh1R2v, "cf-kling-v4": cfKlingV4,
  "cf-minimax-h3": cfMinimaxH3, "cf-p-video-avatar": cfPVideoAvatar, "cf-seedance": cfSeedance, "cf-veo": cfVeo,
  "cf-vidu-q3-turbo": cfViduQ3Turbo, infinitetalk, "local-gpu": localGpu, "minimax-hailuo": minimaxHailuo,
  "own-gpu": ownGpu,
} as unknown as Record<string, Worker>;

// A door with no price says why. Anything else must carry one, so dropping a price goes red here.
const UNPRICED: Record<string, string> = {
  "cf-seedance": "the Cloudflare model page lists no price",
  "local-gpu": "the user's own hardware",
  "own-gpu": "GPU seconds on our endpoint, not a listed price",
};

const FACE_HOLD = ["drift", "one", "two", "hold"] as const;

type Manifest = {
  name: string;
  hooks: string[];
  config_schema?: Record<string, { type: string; values?: string[] }>;
  ui?: { cost?: string; cost_usd_per_second?: unknown; cost_usd_per_clip?: unknown; limits?: string[] };
  usage?: Record<string, unknown> & { duration_steps?: number[]; face_hold?: string };
};

async function manifest(name: string): Promise<Manifest> {
  const res = await DOORS[name].fetch(new Request("https://m/module.json"), {} as never, {} as never);
  return (await res.json()) as Manifest;
}

function resolutionValues(m: Manifest): string[] | null {
  for (const k of ["resolution", "size"]) {
    const f = m.config_schema?.[k];
    if (f && f.type === "enum" && Array.isArray(f.values)) return f.values;
  }
  return null;
}

describe("every motion door declares a face grade and a price (cf#1246)", () => {
  for (const name of Object.keys(DOORS)) {
    it(`${name}: is a motion door with a valid usage.face_hold`, async () => {
      const m = await manifest(name);
      expect(m.name).toBe(name);
      expect(m.hooks).toContain("motion.backend");
      expect(FACE_HOLD).toContain(m.usage?.face_hold);
    });

    it(`${name}: face_hold matches the grade the panel computes today`, async () => {
      const m = await manifest(name);
      const want = FACE_HOLD[faceGrade(m as never)];
      expect(m.usage?.face_hold).toBe(want);
    });

    it(`${name}: carries exactly one well-formed price, or is named as unpriced`, async () => {
      const m = await manifest(name);
      const ps = m.ui?.cost_usd_per_second;
      const pc = m.ui?.cost_usd_per_clip;
      if (UNPRICED[name]) {
        expect(ps).toBeUndefined();
        expect(pc).toBeUndefined();
        return;
      }
      expect((ps === undefined) !== (pc === undefined)).toBe(true);
      expect(m.ui?.cost).not.toBe("Pay per render");
      if (ps !== undefined) {
        expect(Array.isArray(ps) && ps.length === 2).toBe(true);
        const [lo, hi] = ps as number[];
        expect(lo > 0 && Number.isFinite(lo)).toBe(true);
        expect(hi >= lo && Number.isFinite(hi)).toBe(true);
        return;
      }
      expect(Array.isArray(pc) && (pc as unknown[]).length > 0).toBe(true);
      const res = resolutionValues(m);
      const steps = m.usage?.duration_steps;
      for (const p of pc as { usd: number; resolution?: string; seconds?: number }[]) {
        expect(p.usd > 0 && Number.isFinite(p.usd)).toBe(true);
        if (p.resolution !== undefined) expect(res).toContain(p.resolution);
        if (p.seconds !== undefined) expect(steps).toContain(p.seconds);
      }
    });
  }

  it("the unpriced list names only real doors, each with a reason", () => {
    for (const [name, why] of Object.entries(UNPRICED)) {
      expect(DOORS[name]).toBeDefined();
      expect(why.length).toBeGreaterThan(0);
    }
  });

  it("an unpriced metered door says so in its own limits", async () => {
    const m = await manifest("cf-seedance");
    expect((m.ui?.limits ?? []).some((l) => /no price/i.test(l))).toBe(true);
  });

  it("the face grades agree with the panel's own scale", () => {
    expect(FACE_HOLD.map((_, i) => i)).toEqual([GRADE.DRIFT, GRADE.ONE, GRADE.TWO, GRADE.HOLD]);
    expect(Object.keys(FACE_EVIDENCE).every((n) => n in DOORS)).toBe(true);
  });
});
