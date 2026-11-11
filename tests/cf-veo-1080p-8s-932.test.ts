// cf#932: Veo 3.1 makes 1080p at 8 seconds only, and config_schema cannot say that one field limits
// another. cf-veo now refuses the pair itself, at its own input validation, before the generation
// workflow (and so the provider) is started.

import { describe, expect, it } from "vitest";
import { configRequiresRefusal, validateConfig } from "@skyphusion-labs/vivijure-core/modules/registry";
import { validateManifest } from "@skyphusion-labs/vivijure-core/modules/manifest-validate";
import worker from "../modules/cf-veo/src/index";
import { clampDuration, normalizeConfig, resolutionDurationError } from "../modules/cf-veo/src/params";

type Worker = { fetch(r: Request, e: never, c: never): Promise<Response> };
const W = worker as unknown as Worker;
const CTX = { waitUntil() {}, passThroughOnException() {} } as never;

function env() {
  const created: unknown[] = [];
  const e = {
    GATEWAY_ID: "gw-932",
    I2V_WORKFLOW: { create: async (o: unknown) => { created.push(o); return { id: "wf-932" }; } },
    R2_RENDERS: { put: async () => ({}), get: async () => null },
  };
  return { e, created };
}

async function invoke(e: unknown, seconds: number, resolution: string) {
  const res = await W.fetch(
    new Request("https://module.internal/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: "motion.backend",
        input: { shot_id: "s932", keyframe_url: "https://r2.example/k.png", prompt: "a harbor", seconds },
        config: { resolution },
        context: { project: "p932", job_id: "j932" },
      }),
    }),
    e as never,
    CTX,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("cf#932: resolutionDurationError", () => {
  it.each([4, 6])("1080p at %is is refused, naming both values and what to do", (s) => {
    const err = resolutionDurationError(normalizeConfig({ resolution: "1080p" }), s);
    expect(err).toContain("1080p needs an 8 second clip");
    expect(err).toContain(`this shot is ${s}s`);
    expect(err).toMatch(/Use 720p, or make the shot 8 seconds long/);
  });

  it("1080p at 8s is allowed", () => {
    expect(resolutionDurationError(normalizeConfig({ resolution: "1080p" }), 8)).toBeNull();
  });

  it.each([4, 6, 8])("720p at %is is allowed", (s) => {
    expect(resolutionDurationError(normalizeConfig({ resolution: "720p" }), s)).toBeNull();
  });
});

describe("cf#932: through the real /invoke handler", () => {
  it("1080p on a 4 second shot fails as bad-input and starts no workflow", async () => {
    const { e, created } = env();
    const r = await invoke(e, 4, "1080p");
    expect(r).toMatchObject({ ok: false, reason: "bad-input" });
    expect(String(r.error)).toContain("1080p needs an 8 second clip");
    expect(created).toHaveLength(0);
  });

  it("the check reads the SNAPPED duration: 7s snaps to 6 and is refused, 9s snaps to 8 and runs", async () => {
    expect(clampDuration(7)).toBe(6);
    expect(clampDuration(9)).toBe(8);
    const a = env();
    expect((await invoke(a.e, 7, "1080p")).ok).toBe(false);
    expect(a.created).toHaveLength(0);
    const b = env();
    const ok = await invoke(b.e, 9, "1080p");
    expect(ok).toMatchObject({ ok: true, pending: true });
    expect(b.created).toHaveLength(1);
  });

  it("CONTROL: 720p on a 4 second shot runs, so the refusal is not a broken handler", async () => {
    const { e, created } = env();
    expect(await invoke(e, 4, "720p")).toMatchObject({ ok: true, pending: true });
    expect(created).toHaveLength(1);
  });

  it("the manifest label tells the picker before a render does", async () => {
    const res = await W.fetch(new Request("https://module.internal/module.json"), {} as never, CTX);
    const m = (await res.json()) as { config_schema: { resolution: { label: string } } };
    expect(m.config_schema.resolution.label).toContain("1080p: 8 second shots only");
  });
});

// core#507: the manifest says the same thing at film start. For every planned length, the core's rule
// refuses exactly when the module itself would refuse at invoke, so start-time and invoke-time agree.

describe("cf-veo declares the 1080p rule in its config_schema (core#507)", () => {
  const manifest = async () =>
    (await (await (worker as unknown as { fetch(r: Request, e: unknown): Promise<Response> }).fetch(
      new Request("https://m/module.json"), {},
    )).json()) as { config_schema: Record<string, never>; version: string };

  it("the served manifest carries the rule and validates", async () => {
    const m = await manifest();
    expect(m.version).toBe("0.1.5");
    expect((m.config_schema.resolution as { requires?: unknown }).requires).toEqual([
      { when: "1080p", shot_seconds: { min: 7.5 }, message: "Veo 3.1 makes 1080p only as an 8 second clip" },
    ]);
    expect(typeof validateManifest(m)).toBe("object");
  });

  for (const seconds of [4, 5, 5.4, 6, 7, 7.4, 7.49, 7.5, 7.6, 8, 9, 12]) {
    it(`a ${seconds} s shot: core refuses at start exactly when the module refuses at invoke`, async () => {
      const schema = (await manifest()).config_schema;
      for (const resolution of ["720p", "1080p"]) {
        const atStart = configRequiresRefusal(schema, validateConfig(schema, { resolution }), { shot_id: "s", seconds });
        const atInvoke = resolutionDurationError(normalizeConfig({ resolution }), clampDuration(seconds));
        expect(atStart === null, `${resolution} ${seconds}s start=${atStart} invoke=${atInvoke}`).toBe(atInvoke === null);
      }
    });
  }
});
