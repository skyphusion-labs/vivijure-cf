import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAST_VOICE_LINE_DEFAULT,
  CAST_VOICE_LINE_MAX_CHARS,
  castVoiceLineKey,
  castVoiceLineRequest,
} from "../src/cast-voice-line";

describe("cast voice line (cf#982)", () => {
  it("uses the saved Aura-1 voice when the body does not name one", () => {
    const r = castVoiceLineRequest("orion", {});
    expect(r.ok && r.value).toEqual({ text: CAST_VOICE_LINE_DEFAULT, voiceId: "orion" });
  });

  it("keeps a valid voice from the body and rejects anything else", () => {
    const kept = castVoiceLineRequest(null, { voice_id: "luna", text: "Hello there." });
    expect(kept.ok && kept.value.voiceId).toBe("luna");
    const bad = castVoiceLineRequest(null, { voice_id: "not-a-speaker" });
    expect(bad.ok).toBe(false);
    const missing = castVoiceLineRequest(null, {});
    expect(missing.ok).toBe(false);
  });

  it("refuses a line over the cap", () => {
    const r = castVoiceLineRequest("angus", { text: "a".repeat(CAST_VOICE_LINE_MAX_CHARS + 1) });
    expect(r.ok).toBe(false);
  });

  it("stores the preview under the cast member, not as a voice-sample clip", () => {
    expect(castVoiceLineKey(7)).toBe("cast/7/voice-line.wav");
  });

  it("the cast page hears one line and does not offer a Seedance sample", () => {
    const html = readFileSync(process.cwd() + "/public/cast.html", "utf8");
    const js = readFileSync(process.cwd() + "/public/cast.js", "utf8");
    expect(html).toContain('id="cast-voice-hear"');
    expect(html).not.toContain("cast-voice-sample");
    expect(html).not.toContain("Generate 5s");
    expect(js).toContain("/voice-line");
    expect(js).not.toContain("/voice-sample");
    expect(js).toContain("from_chat_artifact");
  });
});
