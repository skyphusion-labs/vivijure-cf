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
  quality_tier: "final", render_overrides: null as Record<string, unknown> | null,
  mode: "keyframes-only", output: null,
  keyframes: BUNDLE_SCENES.map((s) => ({ shot_id: s.shot_id, key: `renders/p/${s.shot_id}.png` })),
  locked_shots: null,
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const TALKING_USAGE = {
  native_audio: true, voice: "prompt_lock" as const,
  scatter_native_audio: false, min_seconds: 4, max_seconds: 12,
};
const moduleBinding = (name: string, hooks: string[], locality: string, usage?: typeof TALKING_USAGE) => ({
  fetch: async () =>
    new Response(JSON.stringify({
      name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality },
      ...(usage ? { usage } : {}),
    }),
      { status: 200, headers: { "content-type": "application/json" } }),
});
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "cloud"),
  MODULE_ALIBABA_WAN: moduleBinding("alibaba-wan", ["motion.backend"], "byo"),
  MODULE_SEEDANCE: moduleBinding("seedance", ["motion.backend"], "cloud", TALKING_USAGE),
  // A cloud motion door, so animate-cloud / animate-hybrid are DRIVEABLE. Without it those two are
  // untestable here, and an untestable door quietly becomes an undeclared one.
  MODULE_CLOUD_I2V: moduleBinding("cloud-i2v", ["motion.backend"], "cloud", TALKING_USAGE),
  MODULE_OWN_GPU: moduleBinding("own-gpu", ["motion.backend"], "byo"),
} as unknown as Env;

const post = (path: string, body: unknown) =>
  new Request(`https://studio.example${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

// --- the declaration --------------------------------------------------------------------------
// yes      = the door carries it into the start function
// no       = the door does not, and that is the divergence this issue is about
// internal = resolved inside core rather than passed at the door
// n/a      = does not apply to this door's phase shape, and the reason is recorded
type Cell = "yes" | "no" | "internal" | "n/a";

interface DoorDecl {
  id: string;
  route: string;              // the API_ROUTES pattern, for the derivation check
  path: string;               // the concrete path to drive
  seam: "film" | "fromKeyframes";
  body: Record<string, unknown>;
  caps: { dialogue: Cell; quality_tier: Cell; audio_key: Cell; film_titles: Cell };
  guards: { config_shape: Cell; unsafe_bundle_key: Cell; motion_backend_preflight: Cell; motion_config_preflight: Cell };
  na_reasons: Record<string, string>;
}

// The two n/a KINDS for the motion-backend preflight, kept apart because collapsing them would hide
// a real difference behind one label. The first is temporary and has a named remedy; the second is
// structural and will never move.
const NA_SERVER_NOT_YET_STRICT =
  "this door READS a caller-supplied backend and the panel now NAMES one (cf#345, merged), so the " +
  "guard is reachable here. Not flipped yet: the panel OMITS the field on a cold registry cache, " +
  "which degrades to the door's default today and would become a 400 the moment this turns strict. " +
  "That interaction is not covered by either change alone. TEMPORARY, pending that decision.";
const NA_SERVER_IGNORES_THE_FIELD =
  "animateFromPreview's `finalized` branch NEVER reads args.motionBackend: it resolves " +
  "`mapped.motion_backend ?? gpuDoor` from the PARENT ROW's stored render_overrides. So a panel " +
  "change here would be INERT, sent and ignored, and the strict guard would still refuse. Needs a " +
  "SERVER change first (cf#347), not a panel one. TEMPORARY, but blocked on a different lane.";
const NA_CALLER_ALREADY_EXPLICIT =
  "the panel already sends an explicit cloud model on this route, and the door validates it against " +
  "the installed cloud backends. NOT A GAP: there is no missing caller choice to enforce.";
const NA_NO_MOTION_LEG =
  "keyframes-only: this job has no motion phase at all, so there is no backend to preflight. " +
  "STRUCTURAL, not a gap, and it will never move.";

const FROM_KF_NA = {
  film_titles: "startFilmFromKeyframes takes no film_titles, so no caller of it can pass one",
  unsafe_bundle_key: "takes a render id, not a bundle key; the key comes off the stored parent row",
};

const DOORS: DoorDecl[] = [
  {
    id: "1 panel MAIN render", route: "/api/storyboard/render", path: "/api/storyboard/render", seam: "film",
    body: { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "seedance", qualityTier: "draft",
            shardCount: 1,
            audioKey: "audio/bed.mp3", film_titles: { title: { text: "T" } } },
    caps: { dialogue: "yes", quality_tier: "no", audio_key: "yes", film_titles: "yes" },
    guards: { config_shape: "yes", unsafe_bundle_key: "yes", motion_backend_preflight: "yes", motion_config_preflight: "yes" },
    na_reasons: { dialogue: "derived inside hSubmitRender from the bundle storyboard when the panel omits dialogue_lines (cf#334 door 1)" },
  },
  {
    id: "3 panel render-from-keyframes", route: "/api/storyboard/render-from-keyframes",
    path: "/api/storyboard/render-from-keyframes", seam: "fromKeyframes",
    body: { bundleKey: BUNDLE, qualityTier: "draft", motion_backend: "seedance", audioKey: "audio/bed.mp3",
            film_titles: { title: { text: "T" } } },
    caps: { dialogue: "internal", quality_tier: "no", audio_key: "yes", film_titles: "no" },
    // C2 landed here with the shared pre-flight. #500 did NOT and the gap is declared, not hidden.
    guards: { config_shape: "yes", unsafe_bundle_key: "yes", motion_backend_preflight: "n/a", motion_config_preflight: "yes" },
    na_reasons: {
      motion_backend_preflight: NA_SERVER_NOT_YET_STRICT,
      dialogue: "derived inside hRenderFromKeyframes from the bundle storyboard (cf#334)",
    },
  },
  {
    id: "4a panel finalize", route: "/api/storyboard/renders/:id/finalize",
    path: `/api/storyboard/renders/${PUB}/finalize`, seam: "fromKeyframes",
    body: { audioKey: "audio/bed.mp3" },
    caps: { dialogue: "internal", quality_tier: "no", audio_key: "yes", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a", motion_backend_preflight: "n/a", motion_config_preflight: "yes" },
    na_reasons: { ...FROM_KF_NA, config_shape: "takes no config bag; the parent row's stored overrides are reused",
                  motion_backend_preflight: NA_SERVER_IGNORES_THE_FIELD,
                  dialogue: "derived inside animateFromPreview from the parent bundle (cf#334)" },
  },
  {
    id: "4b panel animate-cloud", route: "/api/storyboard/renders/:id/animate-cloud",
    path: `/api/storyboard/renders/${PUB}/animate-cloud`, seam: "fromKeyframes",
    body: { model: "cloud-i2v", audioKey: "audio/bed.mp3" },
    caps: { dialogue: "internal", quality_tier: "no", audio_key: "yes", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a", motion_backend_preflight: "n/a", motion_config_preflight: "yes" },
    na_reasons: { ...FROM_KF_NA, config_shape: "takes no config bag; the parent row's stored overrides are reused",
                  motion_backend_preflight: NA_CALLER_ALREADY_EXPLICIT,
                  dialogue: "derived inside animateFromPreview from the parent bundle (cf#334)" },
  },
  {
    id: "4c panel animate-hybrid", route: "/api/storyboard/renders/:id/animate-hybrid",
    path: `/api/storyboard/renders/${PUB}/animate-hybrid`, seam: "fromKeyframes",
    body: { defaultBackend: "cloud", defaultCloudModel: "cloud-i2v", audioKey: "audio/bed.mp3" },
    caps: { dialogue: "internal", quality_tier: "no", audio_key: "yes", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a", motion_backend_preflight: "n/a", motion_config_preflight: "yes" },
    na_reasons: { ...FROM_KF_NA, config_shape: "takes no config bag; the parent row's stored overrides are reused",
                  motion_backend_preflight: NA_CALLER_ALREADY_EXPLICIT,
                  dialogue: "derived inside animateFromPreview from the parent bundle (cf#334)" },
  },
  {
    id: "5 panel regen-shot", route: "/api/storyboard/renders/:id/regen-shot",
    path: `/api/storyboard/renders/${PUB}/regen-shot`, seam: "film",
    body: { shotId: "shot_01" },
    caps: { dialogue: "n/a", quality_tier: "no", audio_key: "n/a", film_titles: "n/a" },
    guards: { config_shape: "n/a", unsafe_bundle_key: "n/a", motion_backend_preflight: "n/a", motion_config_preflight: "n/a" },
    na_reasons: {
      motion_backend_preflight: NA_NO_MOTION_LEG,
      motion_config_preflight: NA_NO_MOTION_LEG,
      dialogue: "keyframes-only: no motion, finish or dialogue leg exists on this job",
      audio_key: "keyframes-only: nothing to mux a bed onto",
      film_titles: "keyframes-only: no assembled film to card",
      config_shape: "takes no config bag; the parent row's stored overrides are reused",
      unsafe_bundle_key: "takes a render id; the key comes off the stored parent row",
    },
  },
  {
    id: "6 agent / MCP / Slate", route: "/api/render/film", path: "/api/render/film", seam: "film",
    body: { bundle_key: BUNDLE, scenes: SCENES, motion_backend: "seedance", qualityTier: "draft",
            shardCount: 1,
            audio_key: "audio/bed.mp3", film_titles: { title: { text: "T" } } },
    caps: { dialogue: "yes", quality_tier: "yes", audio_key: "yes", film_titles: "yes" },
    guards: { config_shape: "yes", unsafe_bundle_key: "yes", motion_backend_preflight: "yes", motion_config_preflight: "yes" },
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
  "/api/cast/:id/voice-sample",
  "/api/cast/:id/voice-sample/keep",
  "/api/cast/:id/voice-sample/attach",
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
  "/api/storyboard/renders/:id/retry",
  "/api/storyboard/score-bed",
  "/api/storyboard/yaml",
  "/api/upload",
  "/api/report",
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
  h.film = []; h.fromKeyframes = [];
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
      rows.push(`${d.id.padEnd(30)} http=${res.status} ${cells} cfg_gate=${d.guards.config_shape} motion_pre=${d.guards.motion_backend_preflight} cfg577=${d.guards.motion_config_preflight}` +
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

  it("the finalize family is EXEMPT from the local-gpu pairing rule, and that exemption is defended", async () => {
    // The render door refuses when motion is a LOCAL door and no local KEYFRAME module is installed
    // (vivijure-local#153). The finalize family must NOT be refused in the same configuration: it runs
    // no keyframe pass at all, its keyframes already exist on the parent preview, so the rule that
    // stops keyframes being routed to the cloud has nothing to say about it.
    //
    // Without this row `checkLocalGpuPairing: false` is a declaration nothing defends: the mutation
    // sweep showed that forcing the gate ON for every door left the suite green. Same defect as the
    // n/a cells, one layer down.
    // The byo door is REMOVED, not just joined: defaultGpuDoorModule prefers byo, so leaving it in
    // means the door resolves to it and the pairing rule never sees a local backend at all. The probe
    // would then pass while measuring nothing about the exemption.
    const envLocalOnly = {
      ...(env as unknown as Record<string, unknown>),
      MODULE_ALIBABA_WAN: undefined,
      MODULE_CLOUD_I2V: undefined,
      MODULE_LOCAL_GPU: moduleBinding("local-gpu", ["motion.backend"], "local"),
    } as unknown as Env;
    const res = await worker.fetch(
      post(`/api/storyboard/renders/${PUB}/finalize`, { audioKey: "audio/bed.mp3" }),
      envLocalOnly,
      ctx,
    );
    const text = await res.text();
    expect(res.status, `finalize must not inherit the keyframe pairing rule: ${text}`).toBe(201);
    expect(text).not.toContain("Refusing to silently route keyframes");
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

  it("#500/#504 motion-backend preflight: enforced only where the caller names a backend", async () => {
    for (const d of DOORS) {
      if (d.guards.motion_backend_preflight === "n/a") {
        expect(d.na_reasons.motion_backend_preflight, `${d.id}: n/a with no recorded reason`).toBeTruthy();
      }
      const bare = { ...d.body } as Record<string, unknown>;
      delete bare.motion_backend;
      const res = await worker.fetch(post(d.path, bare), env, ctx);
      const text = await res.text();
      // Same discipline as the #696 probe: a door can 400 for unrelated reasons, so the refusal must
      // NAME the missing choice or it is not evidence this guard is the one that fired.
      //
      // EVERY door is driven, including the n/a ones. An earlier version skipped them after checking a
      // reason string existed, and the mutation sweep caught that: forcing the guard ON for all doors
      // left the suite green, because nothing asserted the n/a doors were NOT enforcing it. That is a
      // cell that cannot fail, sitting inside the column added to make a gap visible.
      const gated = res.status === 400 && text.includes("choose a motion backend");
      expect(gated, `${d.id}: motion_backend_preflight declared ${d.guards.motion_backend_preflight}, gated=${gated}, body=${text}`)
        .toBe(d.guards.motion_backend_preflight === "yes");
    }
  });

  it("the FOUR n/a kinds stay distinct, so no gap borrows another's explanation", () => {
    // The first pass used ONE reason for doors 3, 4a, 4b and 4c. Measuring each against its own
    // handler showed they are four different situations with four different remedies, and collapsing
    // them would have had the finalize door borrowing a fix that cannot possibly reach it.
    const by = (reason: string) =>
      DOORS.filter((d) => d.na_reasons.motion_backend_preflight === reason).map((d) => d.id);
    expect(by(NA_SERVER_NOT_YET_STRICT)).toEqual(["3 panel render-from-keyframes"]);
    expect(by(NA_SERVER_IGNORES_THE_FIELD)).toEqual(["4a panel finalize"]);
    expect(by(NA_CALLER_ALREADY_EXPLICIT)).toEqual(["4b panel animate-cloud", "4c panel animate-hybrid"]);
    expect(by(NA_NO_MOTION_LEG)).toEqual(["5 panel regen-shot"]);
    // Every door declaring n/a must carry one of the four, so a new door cannot land with a blank.
    const known = new Set([NA_SERVER_NOT_YET_STRICT, NA_SERVER_IGNORES_THE_FIELD, NA_CALLER_ALREADY_EXPLICIT, NA_NO_MOTION_LEG]);
    for (const d of DOORS.filter((x) => x.guards.motion_backend_preflight === "n/a")) {
      expect(known.has(d.na_reasons.motion_backend_preflight ?? ""), `${d.id}: unrecognised n/a reason`).toBe(true);
    }
    // A reason that says TEMPORARY must name what closes it, or the word means nothing.
    expect(NA_SERVER_NOT_YET_STRICT).toContain("cf#345");
    expect(NA_SERVER_IGNORES_THE_FIELD).toContain("cf#347");
    // AND the negative half, which is the defect actually worth guarding against: a door must not
    // point at a remedy that cannot reach it. cf#345 (the panel naming a backend) changes NOTHING for
    // finalize, because that branch resolves from the parent row and never reads the caller's value.
    // Without this line the file certifies the SHAPE of the reasons while the content stays wrong,
    // and a reader who sees cf#345 closed concludes the finalize gap closed with it.
    expect(NA_SERVER_IGNORES_THE_FIELD, "finalize must not point at the panel-side remedy").not.toContain("cf#345");
    expect(NA_SERVER_IGNORES_THE_FIELD, "finalize's remedy is a SERVER change").toContain("SERVER");
  });

  it("#577 motion-config preflight: a bogus config key is refused before spend", async () => {
    for (const d of DOORS) {
      if (d.guards.motion_config_preflight === "n/a") {
        expect(d.na_reasons.motion_config_preflight, `${d.id}: n/a with no recorded reason`).toBeTruthy();
      }
      // Where the config comes from differs per door: the request bag for 1/2/3, an explicit map for
      // 6, and the PARENT ROW for the finalize family. The probe has to reach the door's OWN source or
      // it measures nothing about that door.
      // Under EVERY installed backend, not one: doors resolve different backends (animate-cloud picks
      // the cloud door, the rest a byo door), and a bogus key filed under the wrong name is invisible
      // to that door. Encoding each door's resolution rule here is how a probe silently stops
      // reaching its subject, which reads as "no guard" rather than "no measurement".
      const BOGUS = { "alibaba-wan": { bogus_key: 1 }, "seedance": { bogus_key: 1 }, "cloud-i2v": { bogus_key: 1 }, "own-gpu": { bogus_key: 1 }, "keyframe-sdxl": { bogus_key: 1 } };
      const bad = { ...d.body } as Record<string, unknown>;
      if (d.seam === "fromKeyframes" && !("bundleKey" in bad)) {
        PARENT_ROW.render_overrides = { config: BOGUS };
      } else if (d.route === "/api/render/film") {
        bad.motion_config = { bogus_key: 1 };
      } else {
        bad.renderOverrides = { config: BOGUS };
      }
      const res = await worker.fetch(post(d.path, bad), env, ctx);
      const text = await res.text();
      PARENT_ROW.render_overrides = null;
      const gated = res.status === 400 && text.includes("motion_config rejected");
      expect(gated, `${d.id}: motion_config_preflight declared ${d.guards.motion_config_preflight}, gated=${gated}, body=${text}`)
        .toBe(d.guards.motion_config_preflight === "yes");
    }
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
