import { describe, expect, it } from "vitest";
import {
  coerceConfig,
  blenderKey,
  buildRunPodBody,
  passthroughOutput,
  encodePoll,
  decodePoll,
  parseBackendOutput,
  finishedKey,
  defaultConfig,
} from "../modules/finish-blender/src/finish";
import { MANIFEST } from "../modules/finish-blender/src/index";
import worker from "../modules/finish-blender/src/index";
import { DOOR_ROUTE_NAME } from "../modules/_shared/finish-door";
import type { FinishInput } from "../modules/finish-blender/src/contract";

const sample: FinishInput = {
  shot_id: "shot_01",
  clip_key: "renders/p/clips/shot_01.mp4",
  src_fps: 24,
  frames: 48,
};

describe("finish-blender: coerceConfig", () => {
  it("defaults", () => {
    expect(defaultConfig()).toEqual({
      job_type: "grade",
      preset: "filmic_warm",
      strength: 1,
    });
  });
  it("clamps strength and rejects unknown preset", () => {
    const c = coerceConfig({ strength: 9, preset: "nope", job_type: "grade" });
    expect(c.strength).toBe(2);
    expect(c.preset).toBe("filmic_warm");
  });
  it("accepts known preset", () => {
    expect(coerceConfig({ preset: "cool" }).preset).toBe("cool");
  });
});

describe("finish-blender: blenderKey", () => {
  it("appends _bl before extension", () => {
    expect(blenderKey("renders/p/clips/shot.mp4")).toBe("renders/p/clips/shot_bl.mp4");
  });
});

describe("finish-blender: buildRunPodBody", () => {
  it("forwards project and output key", () => {
    const body = buildRunPodBody(sample, coerceConfig({}), "p");
    expect(body.input.project).toBe("p");
    expect(body.input.output_key).toBe("renders/p/clips/shot_01_bl.mp4");
    expect(body.input.preset).toBe("filmic_warm");
  });
});

describe("finish-blender: poll token", () => {
  it("round-trips", () => {
    const tok = encodePoll({
      jobId: "j1",
      shotId: "shot_01",
      srcFps: 24,
      frames: 48,
      submittedAt: 100,
    });
    expect(decodePoll(tok)?.jobId).toBe("j1");
  });
});

describe("finish-blender: parseBackendOutput", () => {
  it("reads clip_key", () => {
    expect(parseBackendOutput({ clip_key: "a_bl.mp4", frames: 10 })?.frames).toBe(10);
  });

  it("parses output_key so a presigned satellite return is not dropped (cf#604)", () => {
    const o = parseBackendOutput({ shot_id: "s", output_key: "renders/p/clips/written.mp4" });
    expect(o?.output_key).toBe("renders/p/clips/written.mp4");
    expect(o?.clip_key).toBeUndefined();
  });
});

describe("finish-blender: finishedKey (cf#604)", () => {
  it("prefers clip_key, falls back to output_key, undefined when neither", () => {
    expect(finishedKey({ clip_key: "a", output_key: "b" })).toBe("a");
    expect(finishedKey({ output_key: "b" })).toBe("b");
    expect(finishedKey({ clip_key: "a" })).toBe("a");
    expect(finishedKey({})).toBeUndefined();
    expect(finishedKey(null)).toBeUndefined();
  });
});

describe("finish-blender: passthroughOutput", () => {
  it("marks degraded", () => {
    const o = passthroughOutput(sample, "no-runpod-secrets");
    expect(o.degraded).toBe("no-runpod-secrets");
    expect(o.clip_key).toBe(sample.clip_key);
  });
});

describe("finish-blender: GET /ready door object (cf#612)", () => {
  type Worker = { fetch(request: Request, env: never): Promise<Response> };
  const w = worker as unknown as Worker;
  const TOKEN = "lft_cf612_blender_ready_probe";

  it("unbound /ready stays byte-identical (no door key)", async () => {
    const res = await w.fetch(
      new Request("https://m.internal/ready"),
      { RUNPOD_API_KEY: "rpa_cf612", RUNPOD_ENDPOINT_ID: "nbfj3iatp62ek9" } as never,
    );
    const body = await res.json() as Record<string, unknown>;
    expect("door" in body).toBe(false);
    expect(body.ok).toBe(true);
  });

  it("a door-backed blender is ready without RunPod credentials", async () => {
    const res = await w.fetch(
      new Request("https://m.internal/ready"),
      { BLENDER_DOOR_TOKEN: TOKEN } as never,
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok, "door-backed blender classified as misconfigured").toBe(true);
    expect(body.module).toBe(MANIFEST.name);
    expect(body.door).toEqual({
      bound: true,
      token: true,
      route: DOOR_ROUTE_NAME,
      routes: [
        { name: DOOR_ROUTE_NAME, token: true },
        { name: "vpc-badbrains", token: true },
        { name: "vpc-jello", token: true },
      ],
    });
  });

  it("never leaks the door token", async () => {
    const res = await w.fetch(
      new Request("https://m.internal/ready"),
      { BLENDER_DOOR_TOKEN: TOKEN } as never,
    );
    expect(await res.text()).not.toContain(TOKEN);
  });
});
