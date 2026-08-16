import { describe, expect, it } from "vitest";
import { mediaFinishHeaders, mediaFinishToken } from "../modules/_shared/media-finish-auth";

describe("mediaFinishToken / mediaFinishHeaders (cf#615)", () => {
  it("unset is fail-open", async () => {
    expect(await mediaFinishToken(undefined)).toBe("");
    expect(await mediaFinishHeaders(undefined)).toEqual({ "content-type": "application/json" });
  });

  it("string token becomes Bearer", async () => {
    expect(await mediaFinishHeaders("abc")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer abc",
    });
  });

  it("Secrets Store handle is awaited", async () => {
    expect(await mediaFinishToken({ get: async () => "from-store" })).toBe("from-store");
  });
});
