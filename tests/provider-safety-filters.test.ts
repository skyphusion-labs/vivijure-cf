import { describe, it, expect } from "vitest";
import { validateConfig } from "@skyphusion-labs/vivijure-core/modules/registry";
import wanWorker from "../modules/alibaba-wan/src/index";
import wanLoraWorker from "../modules/alibaba-wan-lora/src/index";
import talkWorker from "../modules/infinitetalk/src/index";
import castImageWorker from "../modules/cast-image/src/index";
import { buildWanBody } from "../modules/alibaba-wan/src/wan";
import { buildWanLoraBody } from "../modules/alibaba-wan-lora/src/wan-lora";
import { buildKlingBody } from "../modules/infinitetalk/src/kling";
import { buildParams, normalizeConfig } from "../modules/cf-p-video-avatar/src/params";

// Provider safety filters are always on, and no config value can change that.

const SHOT = {
  shot_id: "shot_01",
  keyframe_url: "https://r2/x.png",
  audio_url: "https://r2/line.wav",
  prompt: "a city at dawn",
  seconds: 5,
};
const STORED = { enable_safety_checker: false };

async function schemaOf(worker: { fetch: (r: Request, e: never) => Promise<Response> }) {
  const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
  const manifest = (await res.json()) as { config_schema: Parameters<typeof validateConfig>[0] };
  return manifest.config_schema;
}

describe.each([
  ["alibaba-wan", wanWorker, buildWanBody],
  ["alibaba-wan-lora", wanLoraWorker, buildWanLoraBody],
  ["infinitetalk", talkWorker, buildKlingBody],
] as const)("%s safety filter", (_name, worker, build) => {
  it("is sent on with an empty config", () => {
    expect(build(SHOT as never, {}).input.enable_safety_checker).toBe(true);
  });

  it("stays on when the builder is handed a stored off value", () => {
    expect(build(SHOT as never, STORED).input.enable_safety_checker).toBe(true);
  });

  it("is not a config field, and a stored value is dropped without failing", async () => {
    const schema = await schemaOf(worker as never);
    expect(schema && "enable_safety_checker" in schema).toBe(false);
    const clamped = validateConfig(schema, STORED);
    expect("enable_safety_checker" in clamped).toBe(false);
    expect(build(SHOT as never, clamped).input.enable_safety_checker).toBe(true);
  });
});

describe("cf-p-video-avatar safety filter", () => {
  it("is sent on", () => {
    const params = buildParams(SHOT as never, normalizeConfig({}));
    expect(params.disable_safety_filter).toBe(false);
  });

  it("does not follow config", () => {
    const params = buildParams(SHOT as never, normalizeConfig({ disable_safety_filter: true }));
    expect(params.disable_safety_filter).toBe(false);
  });
});

describe("cast-image provider safety flag", () => {
  const FLAG = "error 3030: Your output has been flagged";

  function harness(run: (model: string) => unknown) {
    const store = new Map<string, string | ArrayBuffer>();
    const models: string[] = [];
    const env = {
      GATEWAY_ID: "gw",
      AI: {
        run: async (model: string) => {
          models.push(model);
          return run(model);
        },
      },
      R2_RENDERS: {
        put: async (k: string, v: string | ArrayBuffer) => {
          store.set(k, v);
        },
        get: async (k: string) => {
          const v = store.get(k);
          return v === undefined ? null : { text: async () => String(v) };
        },
      },
    };
    return { env, models, store };
  }

  async function post(env: unknown, path: string, body: unknown) {
    const res = await castImageWorker.fetch(
      new Request(`https://m/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env as never,
    );
    return (await res.json()) as Record<string, unknown>;
  }

  it("ends the run on a flag, with the provider's reason, on the one model", async () => {
    const h = harness(() => {
      throw new Error(FLAG);
    });
    const start = await post(h.env, "invoke", {
      hook: "cast.image",
      input: { cast_id: 7, portrait_url: "data:image/png;base64,AA==", source_urls: [] },
      config: { num_images: 4 },
      context: { project: "cast-7", job_id: "j" },
    });
    expect(start.pending).toBe(true);
    const r = await post(h.env, "poll", { poll: start.poll });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain(FLAG);
    expect(new Set(h.models).size).toBe(1);
    expect(h.models).toHaveLength(1);
  });

  it("ends the run the same way on a failure that is not a flag", async () => {
    const h = harness(() => {
      throw new Error("connection reset");
    });
    const start = await post(h.env, "invoke", {
      hook: "cast.image",
      input: { cast_id: 7, portrait_url: "data:image/png;base64,AA==", source_urls: [] },
      config: { num_images: 4 },
      context: { project: "cast-7", job_id: "j" },
    });
    const r = await post(h.env, "poll", { poll: start.poll });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("connection reset");
    expect(h.models).toHaveLength(1);
  });

  it("control: a model that answers produces images, so the failures above are real", async () => {
    const h = harness(() => ({ image: "/9j/2wBDAA==" }));
    const start = await post(h.env, "invoke", {
      hook: "cast.image",
      input: { cast_id: 7, portrait_url: "data:image/png;base64,AA==", source_urls: [] },
      config: { num_images: 4 },
      context: { project: "cast-7", job_id: "j" },
    });
    const r = await post(h.env, "poll", { poll: start.poll });
    expect(r.ok).toBe(true);
    expect(h.models.length).toBeGreaterThan(0);
  });
});
