import { describe, it, expect } from "vitest";
import { defaultKeyframeBackendName, withFastestKeyframeDefault } from "../src/default-keyframe";

const CLOUD = [{ name: "cloud-keyframe" }, { name: "keyframe" }];
const GPU_ONLY = [{ name: "keyframe" }];

describe("withFastestKeyframeDefault", () => {
  it("fills omitted keyframe_backend with cloud-keyframe when that module is installed", () => {
    expect(withFastestKeyframeDefault({ motion_backend: "cf-seedance" }, CLOUD)).toEqual({
      motion_backend: "cf-seedance",
      keyframe_backend: "cloud-keyframe",
    });
  });

  it("does the same for own-gpu motion (stills default is independent of the motion door)", () => {
    expect(withFastestKeyframeDefault({ motion_backend: "own-gpu" }, CLOUD)).toEqual({
      motion_backend: "own-gpu",
      keyframe_backend: "cloud-keyframe",
    });
  });

  it("leaves an explicit keyframe_backend alone", () => {
    expect(
      withFastestKeyframeDefault({ motion_backend: "cf-seedance", keyframe_backend: "keyframe" }, CLOUD),
    ).toEqual({ motion_backend: "cf-seedance", keyframe_backend: "keyframe" });
  });

  it("does not invent cloud-keyframe when that module is not installed", () => {
    expect(withFastestKeyframeDefault({ motion_backend: "own-gpu" }, GPU_ONLY)).toEqual({
      motion_backend: "own-gpu",
    });
  });

  it("does not redirect local-gpu (core coupling owns that pick)", () => {
    expect(withFastestKeyframeDefault({ motion_backend: "local-gpu" }, CLOUD)).toEqual({
      motion_backend: "local-gpu",
    });
  });

  it("defaults a missing overrides bag", () => {
    expect(withFastestKeyframeDefault(undefined, CLOUD)).toEqual({ keyframe_backend: "cloud-keyframe" });
  });
});

describe("defaultKeyframeBackendName", () => {
  it("defaults omitted stills to cloud-keyframe", () => {
    expect(defaultKeyframeBackendName(undefined, "cf-seedance", CLOUD)).toBe("cloud-keyframe");
    expect(defaultKeyframeBackendName(undefined, "own-gpu", CLOUD)).toBe("cloud-keyframe");
  });

  it("keeps an explicit pick", () => {
    expect(defaultKeyframeBackendName("keyframe", "cf-seedance", CLOUD)).toBe("keyframe");
  });

  it("leaves local-gpu omitted so core can couple", () => {
    expect(defaultKeyframeBackendName(undefined, "local-gpu", CLOUD)).toBeUndefined();
  });
});
