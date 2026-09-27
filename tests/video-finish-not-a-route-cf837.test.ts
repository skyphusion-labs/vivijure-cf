// cf#837: the finish door is a BINDING, and nothing may quietly turn it back into a route.
//
// `wrangler.toml.example` told operators that "a Worker route fronts the Cloudflare Container
// through the FINISH_CONTAINER Durable Object binding and this var points at THAT route". cf#810
// measured that premise false: core is a library running INSIDE this Worker, so a route on this
// Worker would make the Worker fetch itself, and Cloudflare documents that same-zone
// Worker-to-Worker global fetch() fails. The comment is corrected; a comment is a rule, so these
// are the mechanism that fails if the code drifts back toward it.
//
// Both checks carry a POSITIVE CONTROL, because the interesting assertion in each is a NEGATIVE
// ("no such route", "no door") and a negative over an empty collection passes without observing
// anything.

import { describe, it, expect } from "vitest";
import { API_ROUTES } from "../src/index";
import { studioEnv } from "../src/orchestrator-env";
import { videoFinishDoorOf } from "../src/video-finish-binding";
import type { Env } from "../src/env";

/** Minimal bindings studioEnv touches, plus an optional container namespace. */
function rawEnv(withContainer: boolean): Env {
  const bucket = {
    async put() {}, async delete() {}, async head() { return null; },
    async get() { return null; }, async list() { return { objects: [], truncated: false }; },
  };
  const db = { prepare() { return { bind() { return { async run() { return { results: [] }; }, async first() { return null; } }; } }; } };
  const namespace = {
    idFromName(name: string) { return { name, toString: () => name }; },
    get() { return { fetch: async () => new Response(null, { status: 204 }) }; },
  };
  const env: Record<string, unknown> = {
    R2_RENDERS: bucket,
    DB: db,
    // Deliberately the shape the retired comment described: a route on this Worker's own host.
    VIDEO_FINISH_URL: "https://vivijure.skyphusion.org/async/finish",
  };
  if (withContainer) env.FINISH_CONTAINER = namespace;
  return env as unknown as Env;
}

describe("cf#837: no /async/* route on vivijure-studio", () => {
  it("API_ROUTES serves no async finish or status path, and the table is not empty", () => {
    // positive control: the real table, read from the module the fetch handler matches against
    expect(API_ROUTES.length).toBeGreaterThan(20);
    expect(API_ROUTES.map((r) => r.pattern)).toContain("/api/storage/usage");

    const async_ = API_ROUTES.filter((r) => r.pattern.includes("async"));
    // print the offender rather than just a count, so a red run says WHICH route came back
    expect(async_.map((r) => r.method + " " + r.pattern)).toEqual([]);
  });
});

describe("cf#837: the container door beats the URL var, so the var value is never fetched", () => {
  it("synthesises a bound door when FINISH_CONTAINER is present, even pointed at a route", () => {
    const env = studioEnv(rawEnv(true));
    // The var is set to a route on our own host. If the door were the URL, this is the deploy that
    // would silently fetch itself; the door must win before the value is ever read.
    expect(env.VIDEO_FINISH_URL).toBe("https://vivijure.skyphusion.org/async/finish");
    const door = videoFinishDoorOf(env);
    expect(door).not.toBeNull();
    expect(typeof door!.fetch).toBe("function");
  });

  it("NEGATIVE CONTROL: with no FINISH_CONTAINER there is no door at all, so a self-host keeps the HTTPS path", () => {
    const env = studioEnv(rawEnv(false));
    expect(videoFinishDoorOf(env)).toBeNull();
    expect(env.MEDIA_DOOR_FETCHERS).toBeUndefined();
  });
});
