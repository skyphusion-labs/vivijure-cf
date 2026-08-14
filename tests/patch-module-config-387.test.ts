import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#387 -- PATCH /api/modules/:name/config must 400 when the body carries keys the install
// subschema does not own, instead of returning 200 ok:true on a silent no-op clamp.
//
// Reproduction that filed the issue: nested `{ config: { notify_email } }` (the natural guess for
// several other studio routes) was accepted, clamped to {}, and echoed as success while the store
// stayed unchanged. Flat `{ notify_email }` is the correct shape.

const MOD = {
  name: "notify-email",
  hooks: ["notify"],
  config_schema: {
    notify_email: {
      type: "string" as const,
      default: "",
      label: "Notify email address",
      scope: "install" as const,
    },
  },
  ui: { order: 10 },
};

const setInstallConfig = vi.fn(async () => ({ notify_email: "ops@example.org" }));
const loadInstallConfig = vi.fn(async () => ({ notify_email: "" }));

vi.mock("@skyphusion-labs/vivijure-core/modules/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skyphusion-labs/vivijure-core/modules/registry")>();
  return {
    ...actual,
    discoverModules: async () => [MOD],
  };
});

vi.mock("@skyphusion-labs/vivijure-core/operator-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skyphusion-labs/vivijure-core/operator-config")>();
  return {
    ...actual,
    setInstallConfig,
    loadInstallConfig,
  };
});

async function handlerFor(method: string, pattern: string) {
  const { API_ROUTES } = await import("../src/index");
  const r = API_ROUTES.find((x) => x.method === method && x.pattern === pattern);
  if (!r) throw new Error(`route ${method} ${pattern} is not in API_ROUTES`);
  return r.handler;
}

/** Mirror of the router's HttpError mapping (CONTRACT 2.0). */
async function asResponse(fn: () => Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const res = await fn();
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (typeof err.status !== "number") throw e;
    return { status: err.status, body: { error: err.message } };
  }
}

const env = {} as never;
const ctx = {} as never;
const params = { name: "notify-email" };

function patchReq(body: unknown) {
  return new Request("https://s/api/modules/notify-email/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/modules/:name/config refuses silent key discards (cf#387)", () => {
  beforeEach(() => {
    setInstallConfig.mockClear();
    loadInstallConfig.mockClear();
    setInstallConfig.mockResolvedValue({ notify_email: "ops@example.org" });
  });

  it("400s on the nested { config: {...} } body that filed the issue (never writes)", async () => {
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() =>
      h(patchReq({ config: { notify_email: "ops@example.org" } }), env, ctx, params),
    );
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/unknown or non-install config keys: config/);
    expect(String(r.body.error)).toMatch(/allowed: notify_email/);
    expect(setInstallConfig).not.toHaveBeenCalled();
  });

  it("400s on a render-scope / typo key and names it", async () => {
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() =>
      h(patchReq({ quality_tier: "final", bogos: "x" }), env, ctx, params),
    );
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/quality_tier/);
    expect(String(r.body.error)).toMatch(/bogos/);
    expect(setInstallConfig).not.toHaveBeenCalled();
  });

  it("400s on a mixed patch (valid + invalid) -- no partial apply", async () => {
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() =>
      h(patchReq({ notify_email: "ops@example.org", extra: 1 }), env, ctx, params),
    );
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/extra/);
    expect(setInstallConfig).not.toHaveBeenCalled();
  });

  it("200s and writes a flat install-key body (the positive control from the issue)", async () => {
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() =>
      h(patchReq({ notify_email: "ops@example.org" }), env, ctx, params),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, module: "notify-email", config: { notify_email: "ops@example.org" } });
    expect(setInstallConfig).toHaveBeenCalledTimes(1);
    const call = setInstallConfig.mock.calls[0] as unknown as [
      unknown,
      string,
      typeof MOD.config_schema,
      Record<string, unknown>,
    ];
    expect(call[2]).toBe(MOD.config_schema);
    expect(call[3]).toEqual({ notify_email: "ops@example.org" });
  });

  it("200s on empty {} (intentional no-op, no dropped keys)", async () => {
    setInstallConfig.mockResolvedValueOnce({ notify_email: "" });
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() => h(patchReq({}), env, ctx, params));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, module: "notify-email" });
    expect(setInstallConfig).toHaveBeenCalledTimes(1);
  });

  it("400s when the body is not an object", async () => {
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() => h(patchReq(["notify_email"]), env, ctx, params));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/body must be a config object/);
    expect(setInstallConfig).not.toHaveBeenCalled();
  });

  it("404s for an unknown module", async () => {
    const h = await handlerFor("PATCH", "/api/modules/:name/config");
    const r = await asResponse(() =>
      h(patchReq({ notify_email: "x" }), env, ctx, { name: "no-such-module" }),
    );
    expect(r.status).toBe(404);
    expect(setInstallConfig).not.toHaveBeenCalled();
  });
});
