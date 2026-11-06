// cf#911 stage 1: FinishContainer starts its container WITH the token, and says when a caller
// omits it.
//
// What a stub can prove here: which env the container would be started with, that it is in place
// BEFORE the base fetch can start the container, and what is logged. What it cannot prove is that the
// platform passes that env into the process; tests/container-bearer-gate.test.py drives the real
// Python gate with these exact variables, and the live film is the last word.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINISH_CONTAINER_NO_TOKEN_ENV,
  FINISH_CONTAINER_STAGE_ENV,
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
    envVars: { ...FINISH_CONTAINER_NO_TOKEN_ENV },
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
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  return out;
}

describe("finishContainerBearer", () => {
  it("a readable token: the token plus the stage-1 permit, nothing else", async () => {
    const b = await finishContainerBearer({ MEDIA_FINISH_TOKEN: TOKEN } as never);
    expect(b.mode).toBe("token");
    expect(b.vars).toEqual({ [FINISH_CONTAINER_TOKEN_VAR]: TOKEN, ...FINISH_CONTAINER_STAGE_ENV });
    expect(b.vars).not.toHaveProperty("LOCAL_FINISH_ALLOW_UNAUTHENTICATED");
  });

  it("a Secrets Store handle is resolved", async () => {
    const b = await finishContainerBearer({ MEDIA_FINISH_TOKEN: { get: async () => ` ${TOKEN} ` } } as never);
    expect(b.vars[FINISH_CONTAINER_TOKEN_VAR]).toBe(TOKEN);
  });

  it("no readable token (unset, blank, or a handle that throws): today's opt-out, so no lockout", async () => {
    for (const raw of [undefined, "", "   ", { get: async () => { throw new Error("store down"); } }]) {
      const b = await finishContainerBearer({ MEDIA_FINISH_TOKEN: raw } as never);
      expect(b.mode).toBe("open");
      expect(b.vars).toEqual(FINISH_CONTAINER_NO_TOKEN_ENV);
    }
  });
});

describe("FinishContainer.fetch arms the token BEFORE the container can start", () => {
  it("the first request already reaches the container under the token env", async () => {
    logs();
    const { c, seen } = container({ MEDIA_FINISH_TOKEN: TOKEN });
    await c.fetch(new Request(ORIGIN + "/async/finish", { method: "POST", headers: { authorization: "Bearer " + TOKEN } }));
    expect(seen).toEqual([{ [FINISH_CONTAINER_TOKEN_VAR]: TOKEN, ...FINISH_CONTAINER_STAGE_ENV }]);
  });

  it("CONTROL: with no token the container is reached under the opt-out, exactly as before", async () => {
    logs();
    const { c, seen } = container({});
    await c.fetch(new Request(ORIGIN + "/async/finish", { method: "POST" }));
    expect(seen).toEqual([FINISH_CONTAINER_NO_TOKEN_ENV]);
  });

  it("the token is resolved once per instance, not per request", async () => {
    logs();
    const get = vi.fn(async () => TOKEN);
    const { c } = container({ MEDIA_FINISH_TOKEN: { get } });
    await c.fetch(new Request(ORIGIN + "/async/status/a"));
    await c.fetch(new Request(ORIGIN + "/async/status/a"));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("finish_container.bearer_absent is the flip gate", () => {
  it("logs a gated request that carries no Authorization, and never the token", async () => {
    const out = logs();
    const { c } = container({ MEDIA_FINISH_TOKEN: TOKEN });
    await c.fetch(new Request(ORIGIN + "/async/status/a"));
    expect(out.some((l) => l.includes("finish_container.bearer_absent") && l.includes("/async/status/a"))).toBe(true);
    expect(out.some((l) => l.includes('"mode":"token"'))).toBe(true);
    expect(out.join("\n")).not.toContain(TOKEN);
  });

  it("CONTROL: a request WITH the header logs no bearer_absent", async () => {
    const out = logs();
    const { c } = container({ MEDIA_FINISH_TOKEN: TOKEN });
    await c.fetch(new Request(ORIGIN + "/async/finish", { method: "POST", headers: { authorization: "Bearer " + TOKEN } }));
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
