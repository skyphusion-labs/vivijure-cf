// vivijure-cf#1379: core 1.42.0 (core#339) lets the caller pick the dialogue module and send it config.
// The studio's own mint sites must forward `dialogue_backend` and `dialogue_config` from the resolved
// mapping, or a user's choice never reaches the film and the first module by ui.order runs, sent {}.
//
// The invoke itself (which module the dialogue tick calls, and with what config) is core's, tested by
// core's tests/dialogue-select-339.test.ts. What this suite proves is the cf half: the mapping carries the
// choice, a film started the way each door starts it holds it, an unknown name is refused, and every mint
// site forwards it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mapRenderOverridesToModuleConfigs } from "@skyphusion-labs/vivijure-core/film-render-bridge";
import { startFilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import { pickDialogueModule } from "@skyphusion-labs/vivijure-core/modules/dialogue-select";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";

afterEach(() => vi.restoreAllMocks());

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const mod = (name: string, hooks: RegisteredModule["hooks"], order: number, config_schema: RegisteredModule["config_schema"] = {}): RegisteredModule =>
  ({ name, version: "1.0.0", api: MODULE_API, binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`, hooks, config_schema, ui: { order, section: "dialogue" } }) as RegisteredModule;

// The shipped names and ui.order (modules/dialogue-gen order 5, modules/chatterbox order 10). Neither
// shipped module declares config, so chatterbox gets a fixture knob to prove config travels.
const GEN = mod("dialogue-gen", ["dialogue"], 5);
const CHATTER = mod("chatterbox", ["dialogue"], 10, { exaggeration: { type: "float", default: 0.5, min: 0, max: 2 } });
const KF = mod("keyframe", ["keyframe"], 1);
const MODULES = [KF, GEN, CHATTER];

const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
function env() {
  const store = new Map<string, string>();
  let kfInvokes = 0;
  const e = {
    R2_RENDERS: {
      put: async (k: string, v: string) => { store.set(k, v); },
      get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
      head: async () => null,
      delete: async (k: string) => { store.delete(k); },
      list: async () => ({ objects: [], truncated: false }),
    },
    [KF.binding]: { fetch: async (url: string) => (String(url).endsWith("/module.json") ? jsonResp(KF) : (kfInvokes++, jsonResp({ ok: true, pending: true, poll: "k" }))) },
  };
  return { e: e as never, invokes: () => kfInvokes };
}

/** Start a film the way the panel door does: resolve the bag, then hand the dialogue fields to core. */
async function startLikeTheDoor(bag: unknown) {
  const mapped = mapRenderOverridesToModuleConfigs(bag, "final", MODULES);
  const h = env();
  const job = await startFilmJob(h.e, {
    project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    keyframe_backend: mapped.keyframe_backend, keyframe_config: mapped.keyframe_config, keyframes_only: true,
    dialogue_backend: mapped.dialogue_backend, dialogue_config: mapped.dialogue_config,
  }, MODULES);
  return { mapped, job, invokes: h.invokes };
}

describe("a dialogue selection reaches core", () => {
  it("the mapping carries the module and its config", () => {
    const mapped = mapRenderOverridesToModuleConfigs({ dialogue_backend: "chatterbox", config: { chatterbox: { exaggeration: 0.9 } } }, "final", MODULES);
    expect(mapped.dialogue_backend).toBe("chatterbox");
    expect(mapped.dialogue_config).toEqual({ chatterbox: { exaggeration: 0.9 } });
  });

  it("a film started from it holds the choice, and core picks chatterbox, not the first by ui.order", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { job } = await startLikeTheDoor({ dialogue_backend: "chatterbox", config: { chatterbox: { exaggeration: 0.9 } } });
    expect(job.phase).not.toBe("failed");
    expect(job.dialogue_backend).toBe("chatterbox");
    expect(job.dialogue_config).toEqual({ chatterbox: { exaggeration: 0.9 } });
    const pick = pickDialogueModule(MODULES, job.dialogue_backend);
    expect(pick.ok && pick.module?.name).toBe("chatterbox");
  });

  it("CONTROL: with no selection nothing changes: no field on the job, and the first by ui.order runs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { mapped, job } = await startLikeTheDoor({ config: {} });
    expect(mapped.dialogue_backend).toBeUndefined();
    expect(mapped.dialogue_config).toEqual({});
    expect(job.phase).not.toBe("failed");
    expect(job.dialogue_backend).toBeUndefined();
    const pick = pickDialogueModule(MODULES, job.dialogue_backend);
    expect(pick.ok && pick.module?.name).toBe("dialogue-gen");
  });

  it("an unknown module name is refused at submit with its name, before anything is spent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { job, invokes } = await startLikeTheDoor({ dialogue_backend: "elevenlabs" });
    expect(job.phase).toBe("failed");
    expect(job.error).toBe(`dialogue module "elevenlabs" is not installed`);
    expect(invokes()).toBe(0);
  });
});

describe("door sweep: every mint site that forwards a resolved finish_config also forwards the dialogue choice", () => {
  // The cf#537 sweep shape. A site that replays a resolved mapping (`mapped.`) or a stored job (`job.`)
  // carries the choice. The agent door (`a.finish_config`) takes pre-resolved maps with no overrides bag,
  // so it resolves its own dialogue fields; tests/agent-door-dialogue-1391.test.ts covers it (cf#1391).
  const FILES = ["studio.ts", "finalize-from-keyframes.ts", "render-retry.ts"];
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

  it("CONTROL: the matcher finds a known token and can come back empty", () => {
    const s = readFileSync(resolve(SRC, "studio.ts"), "utf8");
    expect(count(s, /(?<![_A-Za-z])finish_config: (mapped|job)\.finish_config/g)).toBeGreaterThan(0);
    expect(count(s, /no_such_token_cf1379/g)).toBe(0);
  });

  it("each such site passes dialogue_backend and dialogue_config from the same source", () => {
    let mints = 0;
    for (const f of FILES) {
      const s = readFileSync(resolve(SRC, f), "utf8");
      for (const from of ["mapped", "job"]) {
        const n = count(s, new RegExp(`(?<![_A-Za-z])finish_config: ${from}\\.finish_config`, "g"));
        mints += n;
        expect(count(s, new RegExp(`dialogue_backend: ${from}\\.dialogue_backend`, "g")), `${f} ${from}. dialogue_backend`).toBe(n);
        expect(count(s, new RegExp(`dialogue_config: ${from}\\.dialogue_config`, "g")), `${f} ${from}. dialogue_config`).toBe(n);
      }
    }
    // DENOMINATOR: panel, from-keyframes, parent retake (studio.ts), finalize, retry.
    expect(mints).toBe(5);
  });
});
