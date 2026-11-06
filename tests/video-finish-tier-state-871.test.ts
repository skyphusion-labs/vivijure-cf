// cf#871: VIDEO_FINISH_TIER_STATE=unprovisionable must win over a non-empty VIDEO_FINISH_URL.
//
// The order is door, then declaration, then URL. The door is an observation (a container this
// deploy can reach); the declaration and the URL are both labels, and the explicit one wins. Both
// halves are asserted: the panel state, and the env studioEnv hands core, so the film path takes
// the same degrade the panel reports.

import { describe, expect, it } from "vitest";
import { studioEnv } from "../src/orchestrator-env";
import type { Env } from "../src/env";
import {
  VIDEO_FINISH_CAPABILITY_KEY,
  VIDEO_FINISH_UNPROVISIONABLE_REASON,
  videoFinishHooksUnavailable,
  videoFinishState,
} from "../src/video-finish-availability";

const URL_ = "https://video-finish.example";
const door = { fetch: async () => new Response("{}") };

describe("videoFinishState order (cf#871)", () => {
  it("the declaration beats a usable URL", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: URL_, VIDEO_FINISH_TIER_STATE: "unprovisionable" })).toBe(
      "unprovisionable",
    );
  });

  it("the panel reports the unprovisionable sentence on the capability key", () => {
    const hooks = videoFinishHooksUnavailable({ VIDEO_FINISH_URL: URL_, VIDEO_FINISH_TIER_STATE: "unprovisionable" });
    expect(hooks[VIDEO_FINISH_CAPABILITY_KEY]).toBe(VIDEO_FINISH_UNPROVISIONABLE_REASON);
  });

  it("CONTROL: the same URL with no declaration is available", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: URL_ })).toBe("available");
    expect(videoFinishState({ VIDEO_FINISH_URL: URL_, VIDEO_FINISH_TIER_STATE: "provisionable" })).toBe("available");
  });

  it("only the exact value is a declaration; a near miss does not hide a working tier", () => {
    for (const v of ["Unprovisionable", " unprovisionable", "unprovisionable ", "true", ""]) {
      expect(videoFinishState({ VIDEO_FINISH_URL: URL_, VIDEO_FINISH_TIER_STATE: v }), JSON.stringify(v)).toBe("available");
    }
  });

  it("the door still wins over the declaration, with or without a URL", () => {
    const fetchers = { MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door } };
    expect(videoFinishState({ ...fetchers, VIDEO_FINISH_TIER_STATE: "unprovisionable" })).toBe("available");
    expect(videoFinishState({ ...fetchers, VIDEO_FINISH_URL: URL_, VIDEO_FINISH_TIER_STATE: "unprovisionable" })).toBe(
      "available",
    );
  });
});

describe("studioEnv hands core the same answer (cf#871)", () => {
  it("clears the URL when the studio is declared unprovisionable, so core degrades", () => {
    const e = studioEnv({ VIDEO_FINISH_URL: URL_, VIDEO_FINISH_TIER_STATE: "unprovisionable" } as Env);
    expect(e.VIDEO_FINISH_URL).toBeUndefined();
    expect(videoFinishState(e)).toBe("unprovisionable");
  });

  it("CONTROL: keeps the URL with no declaration", () => {
    const e = studioEnv({ VIDEO_FINISH_URL: URL_ } as Env);
    expect(e.VIDEO_FINISH_URL).toBe(URL_);
  });

  it("keeps the URL when the container is bound, because the door wins", () => {
    const e = studioEnv({
      VIDEO_FINISH_URL: URL_,
      VIDEO_FINISH_TIER_STATE: "unprovisionable",
      FINISH_CONTAINER: { idFromName: () => ({}), get: () => door },
    } as unknown as Env);
    expect(e.VIDEO_FINISH_URL).toBe(URL_);
    expect(videoFinishState(e)).toBe("available");
  });
});
