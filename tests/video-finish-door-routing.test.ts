import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_INSTANCE,
  FINISH_AFFINITY_HEADER,
  forwardToInstance,
  instanceName,
} from "../containers/video-finish/cf-container/src/routing";
import { FINISH_AFFINITY_HEADER as MODULE_HEADER, finishAffinity, withAffinity } from "../modules/_shared/finish-affinity";
import { FINISH_AFFINITY_HEADER as CORE_DOOR_HEADER } from "../src/video-finish-binding";
import { decodePoll, encodePoll } from "../modules/film-titles/src/film-titles";
import { decodePoll as decodeSubtitlePoll, encodePoll as encodeSubtitlePoll } from "../modules/subtitle/src/subtitle";

const here = __dirname;
const req = (headers: Record<string, string> = {}) => new Request("https://door/async/film-titles", { method: "POST", headers });

describe("which instance serves a request", () => {
  it("one film goes to one instance, and two films to two", () => {
    const a = instanceName(new Headers({ [FINISH_AFFINITY_HEADER]: "film-a" }));
    expect(a).toBe(instanceName(new Headers({ [FINISH_AFFINITY_HEADER]: "film-a" })));
    expect(a).not.toBe(instanceName(new Headers({ [FINISH_AFFINITY_HEADER]: "film-b" })));
    expect(a).not.toBe(FALLBACK_INSTANCE);
  });

  it("no header keeps the old fixed instance, where older jobs are", () => {
    expect(instanceName(new Headers())).toBe("subtitle");
    expect(instanceName(new Headers({ [FINISH_AFFINITY_HEADER]: "  " }))).toBe("subtitle");
  });

  it("a submit and its status read reach the same instance", async () => {
    const seen: string[] = [];
    const send = async (name: string) => { seen.push(name); return new Response("{}"); };
    await forwardToInstance(req({ [FINISH_AFFINITY_HEADER]: "film-a" }), send);
    await forwardToInstance(new Request("https://door/async/status/j", { headers: { [FINISH_AFFINITY_HEADER]: "film-a" } }), send);
    expect(new Set(seen).size).toBe(1);
  });

  it("no film id can name the fallback instance", () => {
    expect(instanceName(new Headers({ [FINISH_AFFINITY_HEADER]: "subtitle" }))).not.toBe(FALLBACK_INSTANCE);
  });
});

describe("a full door", () => {
  const full = "There is no Container instance available at this time";
  it("answers 429 for a refusal, thrown or returned", async () => {
    const thrown = await forwardToInstance(req(), async () => { throw new Error(full); });
    expect(thrown.status).toBe(429);
    const returned = await forwardToInstance(req(), async () => new Response(full, { status: 503 }));
    expect(returned.status).toBe(429);
    expect(await returned.json()).toMatchObject({ error: "capacity_exhausted" });
  });
  it("passes a real crash through untouched, so it is not read as capacity", async () => {
    const crash = await forwardToInstance(req(), async () => new Response("ffmpeg died", { status: 500 }));
    expect(crash.status).toBe(500);
    await expect(forwardToInstance(req(), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
  it("leaves a normal answer alone", async () => {
    const ok = await forwardToInstance(req(), async () => new Response("{}", { status: 202 }));
    expect(ok.status).toBe(202);
  });
});

describe("the real door wiring", () => {
  it("routes through forwardToInstance, with the fixed name only as the fallback", () => {
    const src = readFileSync(join(here, "../containers/video-finish/cf-container/src/index.ts"), "utf8");
    expect(src).toContain("forwardToInstance(request, (name, req) => getContainer(env.FINISH, name).fetch(req))");
    expect(src).not.toContain('getContainer(env.FINISH, "subtitle")');
  });
  it("is the size this door was ruled to be", () => {
    const toml = readFileSync(join(here, "../containers/video-finish/cf-container/wrangler.toml"), "utf8");
    expect(toml).toMatch(/^instance_type = "standard-4"$/m);
    expect(toml).toMatch(/^max_instances = 20$/m);
  });
});

describe("the modules", () => {
  it("use one header name with the door and the bound path", () => {
    expect(MODULE_HEADER).toBe(FINISH_AFFINITY_HEADER);
    expect(MODULE_HEADER).toBe(CORE_DOOR_HEADER);
  });
  it("prefer the film id, which is the same for every step of a film", () => {
    expect(finishAffinity({ contextJobId: "film-1", filmKey: "renders/p/film-ff0.mp4" })).toBe("film-1");
    expect(finishAffinity({ filmKey: "renders/p/film.mp4" })).toBe("renders/p/film.mp4");
    expect(finishAffinity({})).toBeUndefined();
  });
  it("send no header when there is no value, so the door uses its fallback", () => {
    expect(withAffinity({ a: "b" }, undefined)).toEqual({ a: "b" });
    expect(withAffinity({ a: "b" }, "film-1")).toEqual({ a: "b", [FINISH_AFFINITY_HEADER]: "film-1" });
  });
  it.each([["film-titles", encodePoll, decodePoll], ["subtitle", encodeSubtitlePoll, decodeSubtitlePoll]] as const)(
    "%s keeps the instance in its poll token, so status reaches the job",
    (_n, enc, dec) => {
      const base = { jobId: "j", filmKey: "k", outputKey: "o", submittedAt: 1, notFoundStreak: 0 };
      const token = (enc as (s: unknown) => string)({ ...base, titleSeconds: 0, affinity: "film-1" });
      expect((dec as (t: string) => { affinity?: string } | null)(token)?.affinity).toBe("film-1");
      const old = (enc as (s: unknown) => string)({ ...base, titleSeconds: 0 });
      expect((dec as (t: string) => { affinity?: string } | null)(old)?.affinity).toBeUndefined();
    },
  );
  it.each(["film-titles", "subtitle"])("%s sends the header on submit, sync and status", (m) => {
    const src = readFileSync(join(here, `../modules/${m}/src/index.ts`), "utf8");
    expect(src.match(/withAffinity\(await mediaFinishHeaders\(env\.MEDIA_FINISH_TOKEN\), finishAffinity\(corr\)\)/g)).toHaveLength(2);
    expect(src).toContain("withAffinity(await mediaFinishHeaders(env.MEDIA_FINISH_TOKEN), st.affinity)");
  });
});
