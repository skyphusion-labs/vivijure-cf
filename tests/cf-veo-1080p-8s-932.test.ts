// cf#932: Veo 3.1 makes 1080p at 8 seconds only, and config_schema cannot say that one field limits
// another. cf-veo now refuses the pair itself, at its own input validation, before the generation
// workflow (and so the provider) is started.

import { describe, expect, it } from "vitest";
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
