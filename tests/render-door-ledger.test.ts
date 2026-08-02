import { describe, it, expect, vi } from "vitest";

// cf#334 -- THE RENDER DOOR LEDGER.
//
// Eight doors spend GPU through core's three start functions and they do not agree about what they
// carry. That survived the studio's entire history for one reason: no test ever compared two doors.
// This file is that test.
//
// It asserts TODAY's behaviour, cell by cell, and fails on drift in EITHER direction: a door that
// starts carrying a capability without its declaration being updated fails exactly as loudly as one
// that stops. The extraction then flips cells one at a time and each flip is a visible diff here
// rather than a green tick quietly appearing.
//
// Five properties it is built to have, because a table like this is otherwise the easiest possible
// thing to make pass vacuously:
//
//   1. DERIVED, NOT TRANSCRIBED. The route list comes from the exported API_ROUTES. Every POST route
//      must be a declared door or an explicit not-a-door, so a route added later lands in neither
//      set and fails this file until someone classifies it. The not-a-door list was generated once
//      by partitioning the real API_ROUTES table, not hand-typed; it FREEZES on purpose, because a
//      list that regenerates itself would absorb a new door silently, which is the whole failure
//      this guard exists to prevent.
//   2. A POSITIVE CONTROL PER COLUMN. Every capability must be observed PRESENT on at least one
//      door. A column where nothing is observed present is a column whose probe cannot see its
//      field, and that is evidence about this harness, not about the doors.
//   3. A FIXED-ANSWER ROW. An unsafe bundle key must 400 on every door that takes one, under the old
//      contract and the new one alike. If that row moves, the harness is lying and nothing else here
//      is a finding.
//   4. GATE PROBES ASSERT THE DIAGNOSTIC, NOT THE STATUS. A door can 400 for reasons that have
//      nothing to do with the gate under test. The #696 probe therefore requires the response to
//      NAME the offending field; status alone once made a door look gated when it was merely
//      refusing for an unrelated reason.
//   5. THE LEDGER PRINTS. Every run emits the table, so the divergence is legible in CI output
//      instead of being implied by an absence of failures.

const h = vi.hoisted(() => ({
  film: [] as Array<Record<string, unknown>>,
  fromKeyframes: [] as Array<Record<string, unknown>>,
  scatter: [] as Array<Record<string, unknown>>,
}));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.film.push(args);
      return { film_id: "film-ledger", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
    startFilmFromKeyframes: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.fromKeyframes.push(args);
      return { film_id: "film-ledger-kf", phase: "clips", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/scatter-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/scatter-orchestrator")>();
  return {
    ...actual,
    startScatterRender: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.scatter.push(args);
      return {
        scatter_id: "scatter-ledger", phase: "keyframe", project: "p", created_at: 0,
        shard_film_ids: [], expected_shot_ids: ["shot_01", "shot_02"],
      };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return {
    ...actual,
    insertRender: vi.fn(async () => {}),
    getRenderIdByPublicId: vi.fn(async () => 1),
    getRenderByIdForUser: vi.fn(async () => PARENT_ROW),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => BUNDLE_SCENES) };
});
vi.mock("../src/bundle-keyframes", async (orig) => {
  const actual = await orig<typeof import("../src/bundle-keyframes")>();
  return {
    ...actual,
    stageBundleInjectedKeyframes: vi.fn(async () =>
      BUNDLE_SCENES.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/p/${s.shot_id}.png` })),
    ),
  };
});

import worker, { API_ROUTES } from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

// The bundle fixture is the verbatim parse of a REAL production bundle
// (bundles/The_Last_Greenhouse.tar.gz) through core's own parseStoryboardScenes: three shots, two
// carrying dialogue. Not an invented shape -- a door that drops dialogue must be dropping the same
// bytes production hands it.
const BUNDLE_SCENES = [
  { shot_id: "shot_01", prompt: "wide, the greenhouse at dusk", seconds: 4,
    dialogue: { slot: "B", text: "So the seed vault is real." } },
  { shot_id: "shot_02", prompt: "close on her face", seconds: 4,
    dialogue: { slot: "A", text: "Hope is the only thing I still grow." } },
  { shot_id: "shot_03", prompt: "the rows of seedlings", seconds: 4 },
];
const SCENES = BUNDLE_SCENES.map((s) => ({ shot_id: s.shot_id, prompt: s.prompt, seconds: s.seconds }));
const BUNDLE = "bundles/The_Last_Greenhouse.tar.gz";
// A real public-id shape. A bare integer is refused by design (the enumeration gate), so a lazy
// fixture id would 404 every id-addressed door and read as "this door starts nothing".
const PUB = "11111111-1111-4111-8111-111111111111";
const PARENT_ROW = {
  id: 1, job_id: "film-parent", project: "p", bundle_key: BUNDLE, status: "COMPLETED",
  quality_tier: "final", render_overrides: null, mode: "keyframes-only", output: null,
  keyframes: BUNDLE_SCENES.map((s) => ({ shot_id: s.shot_id, key: `renders/p/${s.shot_id}.png` })),
  locked_shots: null,
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const moduleBinding = (name: string, hooks: string[], locality: string) => ({
  fetch: async () =>
    new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality } }),
      { status: 200, headers: { "content-type": "application/json" } }),
});
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "cloud"),
  MODULE_ALIBABA_WAN: moduleBinding("alibaba-wan", ["motion.backend"], "byo"),
  // A cloud motion door, so animate-cloud / animate-hybrid are DRIVEABLE. Without it those two are
  // untestable here, and an untestable door quietly becomes an undeclared one.
  MODULE_CLOUD_I2V: moduleBinding("cloud-i2v", ["motion.backend"], "cloud"),
} as unknown as Env;

const post = (path: string, body: unknown) =>
  new Request(`https://studio.example${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

// --- the declaration --------------------------------------------------------------------------
// yes      = the door carries it into the start function
// no       = the door does not, and that is the divergence this issue is about
// internal = resolved inside core rather than passed at the door (scatter reads D1 last_storyboard)
// n/a      = does not apply to this door's phase shape, and the reason is recorded
type Cell = "yes" | "no" | "internal" | "n/a";

interface DoorDecl {
  id: string;
  route: string;              // the API_ROUTES pattern, for the derivation check
  path: string;               // the concrete path to drive
  seam: "film" | "fromKeyframes" | "scatter";
  body: Record<string, unknown>;
  caps: { dialogue: Cell; quality_tier: Cell; audio_key: Cell; film_titles: Cell };
  guards: { config_shape: Cell; unsafe_bundle_key: Cell };
  na_reasons: Record<string, string>;
}

const FROM_KF_NA = {
  film_titles: "startFilmFromKeyframes takes no film_titles, so no caller of it can pass one",
  unsafe_bundle_key: "takes a render id, not a bundle key; the key comes off the stored parent row",
};

const DOORS: DoorDecl[] = [
  {
    id: "1 panel MAIN render", route: "/api/storyboard/render", path: "/api/storyboard/render", seam: "film",
    body: { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan", qualityTier: "draft",
            audioKey: "audio/bed.mp3", film_titles: { title: { text: "T" } } },
    caps: { dialogue: "no", quality_tier: "no", audio_key: "yes", film_titles: "yes" },
    guards: { config_shape: "yes", unsafe_bundle_key: "yes" },
    na_reasons: {},
  },
  {
    id: "2 panel scatter", route: "/api/storyboard/render/scatter", path: "/api/storyboard/render/scatter", seam: "scatter",
    body: { bundleKey: BUNDLE, shotIds: ["shot_01", "shot_02"], shardCount: 2, motion_backend: "alibaba-wan",
            qualityTier: "draft", audioKey: "audio/bed.mp3", film_titles: { title: { text: "T" } } },
    caps: { dialogue: "internal", quality_tier: "yes", audio_key: "yes", film_titles: "yes" },
    // C2 landed here: this door adopted the shared pre-flight and gained the #696 config-shape gate.
    guards: { config_shape: "yes", unsafe_bundle_key: "yes" },
    na_reasons: { dialogue: "resolved inside startScatterRender from D1 last_storyboard, and only when project_id is non-null" },
  },
  {
    id: "3 panel render-from-keyframes", route: "/api/storyboard/render-from-keyframes",
    path: "/api/storyboard/render-from-keyframes", seam: "fromKeyframes",
    body: { bundleKey: BUNDLE, qualityTier: "draft", motion_backend: "alibaba-wan", audioKey: "audio/bed.mp3",
            film_titles: { title: { text: "T" } } },
    caps: { dialogue: "no", quality_tier: "no", audio_key: "yes", film_titles: "no" },
    guards: { config_shape: "no", unsafe_bundle_key: "yes" },
    na_reasons: {},
  },
  {
    id: "4a panel finalize", route: "/api/storyboard/renders/:id/finalize",
    path: `/api/storyboard/renders/${PUB}/finalize`, seam: "fromKeyframes",
    body: { audioKey: "audio/bed.mp3" },
    caps: { dialogue: "no", quality_tier: "no", audio_key: "yes", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a" },
    na_reasons: { ...FROM_KF_NA, config_shape: "takes no config bag; the parent row's stored overrides are reused" },
  },
  {
    id: "4b panel animate-cloud", route: "/api/storyboard/renders/:id/animate-cloud",
    path: `/api/storyboard/renders/${PUB}/animate-cloud`, seam: "fromKeyframes",
    body: { model: "cloud-i2v", audioKey: "audio/bed.mp3" },
    caps: { dialogue: "no", quality_tier: "no", audio_key: "yes", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a" },
    na_reasons: { ...FROM_KF_NA, config_shape: "takes no config bag; the parent row's stored overrides are reused" },
  },
  {
    id: "4c panel animate-hybrid", route: "/api/storyboard/renders/:id/animate-hybrid",
    path: `/api/storyboard/renders/${PUB}/animate-hybrid`, seam: "fromKeyframes",
    body: { defaultBackend: "cloud", defaultCloudModel: "cloud-i2v", audioKey: "audio/bed.mp3" },
    caps: { dialogue: "no", quality_tier: "no", audio_key: "yes", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a" },
    na_reasons: { ...FROM_KF_NA, config_shape: "takes no config bag; the parent row's stored overrides are reused" },
  },
  {
    id: "5 panel regen-shot", route: "/api/storyboard/renders/:id/regen-shot",
    path: `/api/storyboard/renders/${PUB}/regen-shot`, seam: "film",
    body: { shotId: "shot_01" },
    caps: { dialogue: "n/a", quality_tier: "no", audio_key: "n/a", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a" },
    na_reasons: {
      dialogue: "keyframes-only: no motion, finish or dialogue leg exists on this job",
      audio_key: "keyframes-only: nothing to mux a bed onto",
      film_titles: "keyframes-only: no assembled film to card",
      config_shape: "takes no config bag; the parent row's stored overrides are reused",
      unsafe_bundle_key: "takes a render id; the key comes off the stored parent row",
    },
  },
  {
    id: "6 agent / MCP / Slate", route: "/api/render/film", path: "/api/render/film", seam: "film",
    body: { bundle_key: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan", qualityTier: "draft",
            audio_key: "audio/bed.mp3", film_titles: { title: { text: "T" } } },
    caps: { dialogue: "yes", quality_tier: "yes", audio_key: "yes", film_titles: "yes" },
    guards: { config_shape: "yes", unsafe_bundle_key: "yes" },
    na_reasons: {},
  },
];

// Generated once by partitioning the real API_ROUTES POST set against the door routes above, not
// hand-typed. Frozen deliberately: see property 1 at the top of this file.
const NOT_DOORS = new Set<string>([
  "/api/audio/analyze",
  "/api/cast",
  "/api/cast/export/:id",
  "/api/cast/:id/generate-refs",
  "/api/cast/:id/portrait",
  "/api/cast/:id/ref",
  "/api/cast/:id/source",
  "/api/cast/:id/train-lora",
  "/api/cast/:id/train-wan-lora",
  "/api/cast/import",
  "/api/chat",
  "/api/demo/chat",
  "/api/demo/render",
  "/api/modules/install",
  "/api/render/clips",
  "/api/render/frames",
  "/api/storage/reconcile",
  "/api/storyboard/audio-upload",
  "/api/storyboard/bundle",
  "/api/storyboard/character-ref",
  "/api/storyboard/enhance",
  "/api/storyboard/markers",
  "/api/storyboard/music-generate",
  "/api/storyboard/plan",
  "/api/storyboard/preflight",
  "/api/storyboard/projects",
  "/api/storyboard/projects/:id/storyboard",
  "/api/storyboard/refine",
  "/api/storyboard/render-plan",
  "/api/storyboard/renders/adopt",
  "/api/storyboard/renders/:id/add-audio",
  "/api/storyboard/renders/:id/add-narration",
  "/api/storyboard/score-bed",
  "/api/storyboard/yaml",
  "/api/upload",
]);

const CAP_KEYS = ["dialogue", "quality_tier", "audio_key", "film_titles"] as const;

function observed(args: Record<string, unknown> | undefined) {
  if (!args) return null;
  const lines = args.dialogue_lines as unknown[] | undefined;
  return {
    dialogue: Array.isArray(lines) && lines.length > 0,
    quality_tier: args.quality_tier !== undefined,
    audio_key: args.audio_key !== undefined,
    film_titles: args.film_titles !== undefined,
  };
}

async function drive(d: DoorDecl) {
  h.film = []; h.fromKeyframes = []; h.scatter = [];
  const res = await worker.fetch(post(d.path, d.body), env, ctx);
  // Read the body on every drive, not only on failure: a refusal that does not say WHY sends the
  // next reader to the wrong file, and a verdict without its evidence cannot be audited.
  const body = await res.clone().text();
  return { res, body, args: h[d.seam][0], obs: observed(h[d.seam][0]) };
}

describe("cf#334 render door ledger", () => {
  it("LEDGER (printed every run)", async () => {
    const rows: string[] = [];
    for (const d of DOORS) {
      const { res, obs } = await drive(d);
      const cells = CAP_KEYS.map((k) => `${k}=${d.caps[k]}`).join(" ");
      rows.push(`${d.id.padEnd(30)} http=${res.status} ${cells} config_shape_gate=${d.guards.config_shape}` +
                (obs ? ` | observed dialogue=${obs.dialogue}` : " | start fn NOT reached"));
    }
    console.log("\n=== cf#334 RENDER DOOR LEDGER ===\n" + rows.join("\n") + "\n");
    expect(rows.length).toBe(DOORS.length);
  });

  it("DERIVED: every POST route is a declared door or an explicit not-a-door", () => {
    const declared = new Set(DOORS.map((d) => d.route));
    const postRoutes = API_ROUTES.filter((r) => r.method === "POST").map((r) => r.pattern);
    const unclassified = postRoutes.filter((p) => !declared.has(p) && !NOT_DOORS.has(p));
    expect(unclassified, "a POST route is neither a declared door nor an explicit not-a-door").toEqual([]);
    // Both floors: an empty or unimportable route table would otherwise pass vacuously, and a door
    // whose pattern does not exist in the table would silently never be checked against anything.
    expect(postRoutes.length).toBeGreaterThan(30);
    const phantom = [...declared].filter((p) => !postRoutes.includes(p));
    expect(phantom, "a declared door names a route that does not exist in API_ROUTES").toEqual([]);
  });

  for (const d of DOORS) {
    it(`${d.id}: observed capabilities match the declaration`, async () => {
      const { res, body, args, obs } = await drive(d);
      expect(res.status, `${d.id} did not reach its start function: ${body}`).toBeLessThan(400);
      expect(args, `${d.id} called no start function`).toBeDefined();
      for (const key of CAP_KEYS) {
        const decl = d.caps[key];
        if (decl === "n/a" || decl === "internal") {
          expect(d.na_reasons[key], `${d.id}.${key} declared ${decl} with no recorded reason`).toBeTruthy();
          continue;
        }
        expect(obs![key], `${d.id}.${key}: declared ${decl}, observed ${obs![key]}`).toBe(decl === "yes");
      }
    });
  }

  it("POSITIVE CONTROL: every capability column is observed PRESENT on at least one door", async () => {
    const seen: Record<string, boolean> = { dialogue: false, quality_tier: false, audio_key: false, film_titles: false };
    for (const d of DOORS) {
      const { obs } = await drive(d);
      if (!obs) continue;
      for (const k of CAP_KEYS) if (obs[k]) seen[k] = true;
    }
    // A column nothing is observed to have is a column this harness cannot see. That is a fact about
    // the probe, not about the doors, and it must fail rather than read as "everything is missing".
    expect(seen, "a capability column with no observed presence cannot evidence its absences").toEqual({
      dialogue: true, quality_tier: true, audio_key: true, film_titles: true,
    });
  });

  it("FIXED-ANSWER ROW: an unsafe bundle key is refused by every door that takes one", async () => {
    const checked: string[] = [];
    for (const d of DOORS.filter((x) => x.guards.unsafe_bundle_key === "yes")) {
      const bad = { ...d.body };
      if ("bundleKey" in bad) bad.bundleKey = "../../etc/passwd";
      if ("bundle_key" in bad) bad.bundle_key = "../../etc/passwd";
      const res = await worker.fetch(post(d.path, bad), env, ctx);
      expect(res.status, `${d.id} accepted an unsafe bundle key`).toBe(400);
      checked.push(d.id);
    }
    // Row-count floor: if the filter ever selected nothing, this row would pass having tested nothing.
    expect(checked.length, "the fixed-answer row selected no doors").toBeGreaterThan(2);
  });

  it("#696 config-shape gate: named-field refusal on the declared doors, absent on the rest", async () => {
    for (const d of DOORS) {
      if (d.guards.config_shape === "n/a") {
        expect(d.na_reasons.config_shape, `${d.id} config_shape n/a with no reason`).toBeTruthy();
        continue;
      }
      const field = d.route === "/api/render/film" ? "film_finish_config" : "renderOverrides";
      const bad = { ...d.body, [field]: "not-an-object" } as Record<string, unknown>;
      const res = await worker.fetch(post(d.path, bad), env, ctx);
      const text = await res.text();
      // Status alone is not the observable: a door can 400 for reasons unrelated to this gate, which
      // would read as gated when it is merely refusing. Require the refusal to NAME the field.
      const gated = res.status === 400 && text.includes(field);
      expect(gated, `${d.id}: config_shape declared ${d.guards.config_shape}, gated=${gated}, body=${text}`)
        .toBe(d.guards.config_shape === "yes");
    }
  });
});
