import { describe, expect, it } from "vitest";
import { isQuarantineKey } from "../src/abuse-report";

describe("isQuarantineKey", () => {
  it("holds are under quarantine/", () => {
    expect(isQuarantineKey("quarantine/2026/HOLD.json")).toBe(true);
    expect(isQuarantineKey("renders/p/clips/s.mp4")).toBe(false);
  });
});
