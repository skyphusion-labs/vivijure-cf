import { describe, it, expect } from "vitest";
import {
  sniffAudioFormat,
  appliedTagsForDelivered,
  mimeForFormat,
  audioKey,
} from "../modules/narration-gen/src/narration-gen";

// cf#389: label the artifact from the bytes, not the request.

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

describe("sniffAudioFormat (cf#389)", () => {
  it("detects ID3-tagged MP3 (the measured live failure shape)", () => {
    // Live sample started with ID3 004 ...
    const id3 = bytes(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
    expect(sniffAudioFormat(id3, "audio/wav")).toBe("mp3"); // header lies; bytes win
  });

  it("detects RIFF/WAVE", () => {
    const wav = bytes(
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    );
    expect(sniffAudioFormat(wav)).toBe("wav");
  });

  it("detects fLaC", () => {
    expect(sniffAudioFormat(bytes(0x66, 0x4c, 0x61, 0x43, 0x00))).toBe("flac");
  });

  it("uses content-type when magic is unknown", () => {
    expect(sniffAudioFormat(bytes(0x00, 0x01, 0x02, 0x03), "audio/flac")).toBe("flac");
  });
});

describe("appliedTagsForDelivered (cf#389)", () => {
  it("reports actual format and keeps requested when they differ", () => {
    expect(appliedTagsForDelivered("wav", "mp3")).toEqual([
      "format:mp3",
      "format_requested:wav",
    ]);
  });

  it("does not invent a format_requested when they match", () => {
    expect(appliedTagsForDelivered("mp3", "mp3")).toEqual(["format:mp3"]);
  });
});

describe("key and mime follow actual format", () => {
  it("names the key with the sniffed extension", () => {
    expect(audioKey("job-1", "mp3")).toBe("out/narr-job-1.mp3");
    expect(mimeForFormat("mp3")).toBe("audio/mpeg");
  });
});
