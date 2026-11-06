// cf#911 stage 2: FinishContainer starts its container with the token ALONE, and with no readable
// token it refuses at the Durable Object without starting the container.
//
// What a stub can prove here: which env the container would be started with, that it is in place
// BEFORE the base fetch can start the container, the refusal, and what is logged. What it cannot
// prove is that the platform passes that env into the process; tests/container-bearer-gate.test.py
// drives the real Python gate with this exact variable, and the live film is the last word.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINISH_CONTAINER_NO_TOKEN_STATUS,
  FINISH_CONTAINER_TOKEN_VAR,
  FinishContainer,
  bearerAbsent,
  finishContainerBearer,
} from "../src/finish-container";
import { FinishJobTail, RUNNING_SLEEP_AFTER } from "../src/finish-job-tail";

const ORIGIN = "http://video-finish";
const TOKEN = "tok-911-not-a-real-value";

afterEach(() => vi.restoreAllMocks());

/** The real FinishContainer.fetch and base Container.fetch over a fake containerFetch that records
 *  the envVars in force at the moment the container would be reached. */
function container(env: Record<string, unknown>) {
  const seen: Record<string, string>[] = [];
  const c = Object.create(FinishContainer.prototype) as FinishContainer & Record<string, unknown>;
  Object.assign(c, {
    defaultPort: 8000,
    sleepAfter: RUNNING_SLEEP_AFTER,
    sleepAfterMs: 0,
    jobTail: new FinishJobTail(),
    envVars: {},
    env,
    containerFetch: async () => {
      seen.push({ ...(c.envVars as Record<string, string>) });
      return new Response("{}", { status: 200 });
    },
  });
  return { c, seen };
}

function logs() {
  const out: string[] = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  }
  return out;
}

const authed = (path: string) => new Request(ORIGIN + path, { method: "POST", headers: { authorization: "Bearer " + TOKEN } });

describe("finishContainerBearer", () => {
  it("a readable token: the token var and NOTHING else", async () => {
    const b = await finishContainerBearer({ MEDIA_FINISH_TOKEN: TOKEN } as never);
    expect(b).toEqual({ mode: "token", vars: { [FINISH_CONTAINER_TOKEN_VAR]: TOKEN } });
  });

  it("a Secrets Store handle is resolved", async () => {
    const b = await finishContainerBearer({ MEDIA_FINISH_TOKEN: { get: async () => ` ${TOKEN} ` } } as never);
    expect(b.mode === "token" && b.vars[FINISH_CONTAINER_TOKEN_VAR]).toBe(TOKEN);
  });

  it("no readable token (unset, blank, or a handle that throws): none, with no fallback env", async () => {
    for (const raw of [undefined, "", "   ", { get: async () => { throw new Error("store down"); } }]) {
      expect(await finishContainerBearer({ MEDIA_FINISH_TOKEN: raw } as never)).toEqual({ mode: "none" });
    }
  });
});

describe("FinishContainer.fetch", () => {
  it("the first request already reaches the container under the token env", async () => {
    logs();
    const { c, seen } = container({ MEDIA_FINISH_TOKEN: TOKEN });
    await c.fetch(authed("/async/finish"));
    expect(seen).toEqual([{ [FINISH_CONTAINER_TOKEN_VAR]: TOKEN }]);
  });

  it("NO token: 503 from the object, and the container is NEVER reached", async () => {
    const out = logs();
    const { c, seen } = container({});
    const resp = await c.fetch(authed("/async/finish"));
    expect(resp.status).toBe(FINISH_CONTAINER_NO_TOKEN_STATUS);
    expect(FINISH_CONTAINER_NO_TOKEN_STATUS).toBe(503);
    expect(seen).toEqual([]);
    expect(out.some((l) => l.includes("finish_container.no_token"))).toBe(true);
  });

  it("the token is resolved once per instance, not per request", async () => {
    logs();
    const get = vi.fn(async () => TOKEN);
    const { c } = container({ MEDIA_FINISH_TOKEN: { get } });
    await c.fetch(authed("/async/status/a"));
    await c.fetch(authed("/async/status/a"));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("finish_container.bearer_absent", () => {
  it("logs a gated request that carries no Authorization, and never the token", async () => {
    const out = logs();
    const { c } = container({ MEDIA_FINISH_TOKEN: TOKEN });
    await c.fetch(new Request(ORIGIN + "/async/status/a"));
    expect(out.some((l) => l.includes("finish_container.bearer_absent") && l.includes("/async/status/a"))).toBe(true);
    expect(out.some((l) => l.includes('"mode":"token"') && l.includes('"stage":2'))).toBe(true);
    expect(out.join("\n")).not.toContain(TOKEN);
  });

  it("CONTROL: a request WITH the header logs no bearer_absent", async () => {
    const out = logs();
    const { c } = container({ MEDIA_FINISH_TOKEN: TOKEN });
    await c.fetch(authed("/async/finish"));
    expect(out.some((l) => l.includes("finish_container.bearer_absent"))).toBe(false);
    expect(out.join("\n")).not.toContain(TOKEN);
  });

  it("the health probe is not counted", () => {
    expect(bearerAbsent(new Request(ORIGIN + "/health"))).toBe(false);
    expect(bearerAbsent(new Request(ORIGIN + "/health/"))).toBe(false);
    expect(bearerAbsent(new Request(ORIGIN + "/healthz"))).toBe(true);
    expect(bearerAbsent(new Request(ORIGIN + "/finish"))).toBe(true);
    expect(bearerAbsent(new Request(ORIGIN + "/finish", { headers: { Authorization: "Bearer x" } }))).toBe(false);
  });
});
