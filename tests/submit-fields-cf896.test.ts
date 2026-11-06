// cf#896: the submit doors refuse a field they do not read, and a qualityTier they do not know.
//
// The defect was silence: `quality_tier: "draft"` and a top-level `resolution` were accepted with a 201
// and dropped, so the render ran at `final` and at the motion door's default size. Each case below is a
// body that used to start a render without the caller's value, and must now be a 400 that names it.
// The control is the panel's own body shapes, which must still pass this check.

import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  FILM_SUBMIT_FIELDS,
  FROM_KEYFRAMES_FIELDS,
  PANEL_RENDER_FIELDS,
  qualityTierRefusal,
  unknownSubmitFieldsRefusal,
} from "../src/submit-fields";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("asset") },
  // Past the spend limiter, which answers before any submit handler (fail-closed without it).
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Parameters<typeof worker.fetch>[1];

async function post(path: string, body: unknown): Promise<{ status: number; error: string }> {
  const res = await worker.fetch(
    new Request("https://studio.example" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const j = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { status: res.status, error: String(j.error ?? "") };
}

const PANEL = "/api/storyboard/render";
const FROM_KF = "/api/storyboard/render-from-keyframes";
const FILM = "/api/render/film";
const scenes = [{ shot_id: "s1", prompt: "a cat", seconds: 4 }];

describe("unknownSubmitFieldsRefusal", () => {
  it("passes a body of known fields", () => {
    expect(unknownSubmitFieldsRefusal({ bundleKey: "k", qualityTier: "draft" }, PANEL_RENDER_FIELDS, "door")).toBeNull();
  });
  it("names every unknown field, sorted", () => {
    const m = unknownSubmitFieldsRefusal({ zeta: 1, alpha: 2, bundleKey: "k" }, PANEL_RENDER_FIELDS, "door");
    expect(m).toContain("these fields: alpha, zeta.");
  });
  it("tells quality_tier to use qualityTier", () => {
    expect(unknownSubmitFieldsRefusal({ quality_tier: "draft" }, FILM_SUBMIT_FIELDS, "door")).toContain(
      "quality_tier (the field is qualityTier)",
    );
  });
  it("sends a top-level resolution to the door's own motion config", () => {
    expect(unknownSubmitFieldsRefusal({ resolution: "480p" }, FILM_SUBMIT_FIELDS, "door")).toContain("inside motion_config");
    expect(unknownSubmitFieldsRefusal({ resolution: "480p" }, PANEL_RENDER_FIELDS, "door")).toContain(
      "inside renderOverrides.config",
    );
  });
  it("names the other door's spelling", () => {
    expect(unknownSubmitFieldsRefusal({ bundle_key: "k" }, PANEL_RENDER_FIELDS, "door")).toContain("spells it bundleKey");
    expect(unknownSubmitFieldsRefusal({ bundleKey: "k" }, FILM_SUBMIT_FIELDS, "door")).toContain("spells it bundle_key");
  });
  it("leaves a body that is not an object to the handler", () => {
    for (const b of [null, "x", 3, [1]]) expect(unknownSubmitFieldsRefusal(b, PANEL_RENDER_FIELDS, "door")).toBeNull();
  });
  it("keeps the documented ignored aliases accepted (CONTRACT 2.23)", () => {
    for (const list of [PANEL_RENDER_FIELDS, FILM_SUBMIT_FIELDS]) {
      expect(unknownSubmitFieldsRefusal({ shardCount: 2, shard_count: 2 }, list, "door")).toBeNull();
    }
    expect(FROM_KEYFRAMES_FIELDS).not.toContain("shardCount");
  });
});

describe("qualityTierRefusal", () => {
  it("passes absent, and each known tier", () => {
    expect(qualityTierRefusal({})).toBeNull();
    expect(qualityTierRefusal({ qualityTier: undefined })).toBeNull();
    for (const t of ["draft", "standard", "final"]) expect(qualityTierRefusal({ qualityTier: t })).toBeNull();
  });
  it("refuses a value that used to fall to final", () => {
    for (const t of ["Draft", "low", "", 1, null]) {
      expect(qualityTierRefusal({ qualityTier: t }), JSON.stringify(t)).toContain("qualityTier must be one of draft, standard, final");
    }
  });
});

describe("the submit routes refuse before any work (cf#896)", () => {
  it("panel render: quality_tier is a 400 naming qualityTier", async () => {
    const r = await post(PANEL, { bundleKey: "renders/p/bundle.json", scenes, quality_tier: "draft" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("POST /api/storyboard/render does not read this field: quality_tier (the field is qualityTier)");
  });
  it("panel render: an unknown qualityTier is a 400, not a final render", async () => {
    const r = await post(PANEL, { bundleKey: "renders/p/bundle.json", scenes, qualityTier: "low" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("qualityTier must be one of");
  });
  it("render from keyframes: a top-level resolution is a 400", async () => {
    const r = await post(FROM_KF, { bundleKey: "renders/p/bundle.json", resolution: "480p" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("resolution (a motion door setting goes inside renderOverrides.config)");
  });
  it("film: the reference render's body is a 400 naming both fields", async () => {
    const r = await post(FILM, { bundle_key: "renders/p/bundle.json", scenes, quality_tier: "draft", resolution: "480p" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("quality_tier (the field is qualityTier)");
    expect(r.error).toContain("resolution (a motion door setting goes inside motion_config)");
  });
  it("film: keyframes_only is not read by this door, so it is refused rather than spent as a full film", async () => {
    const r = await post(FILM, { bundle_key: "renders/p/bundle.json", scenes, keyframes_only: true });
    expect(r.status).toBe(400);
    expect(r.error).toContain("keyframes_only");
  });
});

describe("the panel's own bodies still pass the field check (control)", () => {
  // Shapes from public/planner-render.js, public/make.js and public/planner-bundle.js. They fail later
  // for want of a real bundle; what matters is that THIS check does not refuse them.
  const cases: Array<[string, Record<string, unknown>]> = [
    [PANEL, {
      bundleKey: "renders/p/bundle.json", scenes, qualityTier: "draft", renderOverrides: { motion_backend: "m" },
      keyframesOnly: true, audioKey: "audio/a.mp3", style_prefix: "s", voice_lock: "v",
      film_titles: { title: { text: "t" } }, projectId: "p", castLoras: { a: "c" }, idempotency_key: "k",
    }],
    [PANEL, {
      bundleKey: "renders/p/bundle.json", scenes, motion_backend: "m", renderOverrides: { motion_backend: "m", config: {} },
      idempotency_key: "make-1", qualityTier: "standard", castLoras: {}, projectId: "p", style_prefix: "s",
    }],
    [FROM_KF, {
      project: "p", bundleKey: "renders/p/bundle.json", qualityTier: "final", renderOverrides: {},
      audioKey: "audio/a.mp3", motion_backend: "m", idempotency_key: "k",
    }],
  ];
  for (const [path, body] of cases) {
    it(`${path} ${Object.keys(body).length} fields`, async () => {
      const r = await post(path, body);
      expect(r.error).not.toContain("does not read");
      expect(r.error).not.toContain("qualityTier must be one of");
      // The control is only evidence if the check ran on this request: the same body with one stray
      // field must be refused by it. Without this, a 503 before the check would pass the control.
      const stray = await post(path, { ...body, quality_tier: "draft" });
      expect(stray.status).toBe(400);
      expect(stray.error).toContain("does not read this field: quality_tier");
    });
  }
});
