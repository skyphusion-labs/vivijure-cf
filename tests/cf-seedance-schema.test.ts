// Each cf-seedance model is checked against its vendored Cloudflare schema-input.json.
// The files are the published documents, fetched from
// https://developers.cloudflare.com/ai/models/bytedance/<id>/schema-input.json
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import worker from "../modules/cf-seedance/src/index";
import { buildParams, clampDuration, normalizeConfig } from "../modules/cf-seedance/src/params";

const ROOT = join(import.meta.dirname, "..");
const SCHEMA_DIR = join(ROOT, "modules/cf-seedance/schemas");

const MODELS = [
  ["bytedance/seedance-2.5", "seedance-2.5.schema-input.json"],
  ["bytedance/seedance-2.0", "seedance-2.0.schema-input.json"],
  ["bytedance/seedance-2.0-fast", "seedance-2.0-fast.schema-input.json"],
  ["bytedance/seedance-2.0-mini", "seedance-2.0-mini.schema-input.json"],
] as const;

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  anyOf?: Schema[];
  items?: Schema;
  default?: unknown;
  description?: string;
};

function loadSchema(file: string): Schema {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Schema;
}

function durationMax(schema: Schema): number {
  const d = schema.properties?.duration;
  if (!d) throw new Error("no duration");
  if (typeof d.maximum === "number") return d.maximum;
  const ranged = (d.anyOf ?? []).filter((b) => typeof b.maximum === "number");
  if (ranged.length !== 1) throw new Error("duration max is not a single published range");
  return ranged[0].maximum as number;
}

function matches(schema: Schema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.anyOf) {
    const ok = schema.anyOf.some((b) => matches(b, value, path).length === 0);
    if (!ok) errors.push(path + " matched no anyOf branch");
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(path + " const");
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(path + " enum");
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(path + " object");
      return errors;
    }
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errors.push(path + "." + k + " additional");
      }
    }
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(path + "." + req + " required");
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...matches(props[k], v, path + "." + k));
    }
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") errors.push(path + " string");
    else if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(path + " maxLength");
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) errors.push(path + " integer");
    else {
      if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(path + " min");
      if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(path + " max");
    }
  } else if (schema.type === "number") {
    if (typeof value !== "number") errors.push(path + " number");
    else {
      if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(path + " min");
      if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(path + " max");
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(path + " boolean");
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) errors.push(path + " array");
    else {
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(path + " maxItems");
      if (schema.items) value.forEach((item, i) => errors.push(...matches(schema.items as Schema, item, path + "[" + i + "]")));
    }
  }
  return errors;
}

function expectValid(schema: Schema, body: Record<string, unknown>): void {
  expect(matches(schema, body, "$")).toEqual([]);
}

const shot = {
  shot_id: "shot_01",
  keyframe_url: "https://r2.example/k.png",
  prompt: "slow camera push-in",
  seconds: 5,
};

describe("cf-seedance body matches each model's schema-input.json", () => {
  it.each(MODELS)("%s: voice, ratio, resolution, and duration stay inside the published schema", (model, file) => {
    const schema = loadSchema(file);
    expect(schema.additionalProperties).toBe(false);
    const resEnum = schema.properties?.resolution?.enum as string[];
    const arEnum = schema.properties?.aspect_ratio?.enum as string[];
    const max = durationMax(schema);

    const plain = buildParams(shot, normalizeConfig({ model }));
    expectValid(schema, plain);
    expect(plain.resolution).toBe("720p");
    expect(resEnum).toContain("720p");

    const voiced = buildParams(
      { ...shot, voice_ref_url: "https://r2.example/voice.mp4" },
      normalizeConfig({ model }),
    );
    expectValid(schema, voiced);
    if (schema.properties?.reference_videos) {
      expect(voiced.reference_videos).toEqual(["https://r2.example/voice.mp4"]);
      expect(voiced.reference_video).toBeUndefined();
      expect(voiced.reference_audios).toBeUndefined();
    } else {
      expect(voiced.reference_video).toBe("https://r2.example/voice.mp4");
      expect(voiced.reference_videos).toBeUndefined();
      expect(voiced.reference_audio).toBeUndefined();
    }

    const tall = buildParams(shot, normalizeConfig({ model, aspect_ratio: "9:21" }));
    expectValid(schema, tall);
    if (arEnum.includes("9:21")) expect(tall.aspect_ratio).toBe("9:21");
    else expect(tall.aspect_ratio).toBe(schema.properties?.aspect_ratio?.default);

    const hi = buildParams(shot, normalizeConfig({ model, resolution: "1080p" }));
    const fourk = buildParams(shot, normalizeConfig({ model, resolution: "4k" }));
    expectValid(schema, hi);
    expectValid(schema, fourk);
    for (const body of [hi, fourk]) {
      expect(resEnum).toContain(body.resolution);
    }
    if (!resEnum.includes("1080p")) expect(hi.resolution).toBe(schema.properties?.resolution?.default);
    else expect(hi.resolution).toBe("1080p");
    if (!resEnum.includes("4k")) expect(fourk.resolution).toBe(schema.properties?.resolution?.default);
    else expect(fourk.resolution).toBe("4k");

    const over = buildParams({ ...shot, seconds: 40 }, normalizeConfig({ model }));
    expectValid(schema, over);
    expect(over.duration).toBe(max);
    expect(clampDuration(40, model)).toBe(max);

    if (schema.properties?.output_format) {
      expect(plain.output_format).toBe(schema.properties.output_format.default);
    } else {
      expect(plain.output_format).toBeUndefined();
    }

    const flf = buildParams(
      { ...shot, last_keyframe_url: "https://r2.example/end.png", seconds: 8 },
      normalizeConfig({ model, aspect_ratio: "9:16" }),
    );
    expectValid(schema, flf);
    expect(flf.last_frame_image).toBe("https://r2.example/end.png");
    const arDesc = schema.properties?.aspect_ratio?.description ?? "";
    if (arDesc.includes("First/last-frame") && arEnum.includes("adaptive")) {
      expect(flf.aspect_ratio).toBe("adaptive");
    } else {
      expect(flf.aspect_ratio).toBe("9:16");
    }
  });

  it("a long prompt stays inside maxLength and keeps the voice line", () => {
    const schema = loadSchema("seedance-2.5.schema-input.json");
    const cap = schema.properties?.prompt?.maxLength as number;
    const p = buildParams(
      { ...shot, prompt: "a".repeat(cap + 500), voice_ref_url: "https://r2.example/voice.mp4" },
      normalizeConfig({}),
    );
    expectValid(schema, p);
    expect(String(p.prompt).length).toBeLessThanOrEqual(cap);
    expect(String(p.prompt)).toMatch(/reference video/);
  });
});

describe("cf-seedance door limits", () => {
  it("the door limits doc says 2.5 is 4-30s and a vertical first+last clip needs a 9:16 keyframe", () => {
    const doc = readFileSync(join(ROOT, "docs/motion-door-limits.md"), "utf8");
    const section = doc.split("## cf-seedance")[1]?.split("## seedance")[0] ?? "";
    expect(section).toMatch(/4-30 seconds on 2\.5/);
    expect(section).toMatch(/4-12 seconds on 2\.0/);
    expect(section).toMatch(/reference_videos/);
    expect(section).toMatch(/9:16/);
    expect(section).toMatch(/adaptive/);
    expect(section).not.toMatch(/\| Duration \| 4-12 seconds \|/);
  });

  it("the planner card says the same", async () => {
    const res = await worker.fetch(new Request("https://module/module.json"), {} as never, {} as never);
    const m = await res.json() as { ui?: { limits?: string[] } };
    const text = (m.ui?.limits ?? []).join(" ");
    expect(text).toMatch(/30 seconds on 2\.5/);
    expect(text).toMatch(/1080p and 4k are Seedance 2\.0 only/);
    expect(text).toMatch(/9:16 keyframe/);
  });
});

describe("cf-seedance invoke clamps seconds per model", () => {
  function fakeEnv() {
    const created: Array<{ params?: { seconds?: number } }> = [];
    const env = {
      GATEWAY_ID: "gw",
      AI: { async run() { throw new Error("AI.run must not run on the request path"); } },
      R2_RENDERS: { async put() {}, async get() { return null; } },
      I2V_WORKFLOW: {
        async create(options?: { params?: { seconds?: number } }) {
          created.push(options ?? {});
          return { id: "wf-1", async status() { return { status: "running" }; } };
        },
        async get() {
          return { id: "wf-1", async status() { return { status: "running" }; } };
        },
      },
    };
    return { env, created };
  }

  const ctx = { waitUntil() {}, passThroughOnException() {} };

  async function invokedSeconds(model: string, seconds: number): Promise<number> {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(new Request("https://module/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: "motion.backend",
        input: { shot_id: "s", keyframe_url: "https://r2.example/k.png", prompt: "p", seconds },
        config: { model },
        context: { project: "demo", job_id: "job-1" },
      }),
    }), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean };
    expect(j.ok).toBe(true);
    expect(created[0]?.params?.seconds).toBeTypeOf("number");
    return created[0].params!.seconds!;
  }

  it("2.5 keeps 20 seconds and 2.0 clamps 20 to 12", async () => {
    expect(await invokedSeconds("bytedance/seedance-2.5", 20)).toBe(20);
    expect(await invokedSeconds("bytedance/seedance-2.0", 20)).toBe(12);
    expect(await invokedSeconds("bytedance/seedance-2.0-fast", 20)).toBe(12);
    expect(await invokedSeconds("bytedance/seedance-2.0-mini", 20)).toBe(12);
  });
});
