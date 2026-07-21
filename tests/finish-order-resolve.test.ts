import { describe, it, expect } from "vitest";
import {
  resolveFinishChainForShot,
  finishOrderReorderDialogue,
} from "@skyphusion-labs/vivijure-core/film-orchestrator";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";

// cf#29: default dialogue finish order is legacy ui.order (June showcase quality). #584 reorder is opt-in.

const mod = (name: string, order: number, consumesAudio: boolean): RegisteredModule => ({
  name,
  version: "0.0.0",
  api: MODULE_API,
  hooks: ["finish"],
  ui: { order },
  finish_consumes_audio: consumesAudio,
  binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`,
});

const rife = mod("finish-rife", 10, false);
const lipsync = mod("finish-lipsync", 15, true);
const upscale = mod("finish-upscale", 20, false);
const serving = [rife, lipsync, upscale];

describe("resolveFinishChainForShot (cf#29 prod default)", () => {
  it("dialogue shot: legacy ui.order by default", () => {
    const ordered = resolveFinishChainForShot(serving, true, {});
    expect(ordered.map((m) => m.name)).toEqual(["finish-rife", "finish-lipsync", "finish-upscale"]);
  });

  it("dialogue shot: #584 order only when finish-order.dialogue_reorder is true", () => {
    const ordered = resolveFinishChainForShot(serving, true, {
      "finish-order": { dialogue_reorder: true },
    });
    expect(ordered.map((m) => m.name)).toEqual(["finish-lipsync", "finish-rife", "finish-upscale"]);
  });

  it("finishOrderReorderDialogue defaults false", () => {
    expect(finishOrderReorderDialogue(undefined)).toBe(false);
    expect(finishOrderReorderDialogue({ "finish-order": { dialogue_reorder: true } })).toBe(true);
  });
});
