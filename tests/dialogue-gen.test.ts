// dialogue-gen module: per-shot Aura-1 TTS in a Workflow for the `dialogue` hook. Covers the pure
// helpers, the fetch submit/poll lifecycle (#155: gen runs in a Workflow, not request-path waitUntil),
// and the batch workflow loop (one WAV per shot to R2 + a done state carrying the audio map).
import { describe, it, expect } from "vitest";
import worker, { DialogueGenWorkflow } from "../modules/dialogue-gen/src/index";
import {
  resolveVoice,
  normalizeInput,
  audioKey,
  DEFAULT_VOICE_ID,
  AUDIO_MIME,
} from "../modules/dialogue-gen/src/dialogue-gen";
import {
  mintSilenceWav,
  normalizeLineWav,
  parseWavDurationSeconds,
  LINE_WAV_MIN_SECONDS,
  LINE_WAV_MAX_SECONDS,
  LINE_TARGET_DBFS,
  LINE_PEAK_LIMIT_DBFS,
  LINE_FULL_GAIN_DBFS,
} from "../modules/dialogue-gen/src/wav-duration";

// ---- pure helpers ----------------------------------------------------------

describe("dialogue-gen helpers", () => {
  it("resolveVoice keeps a known speaker, falls back to default otherwise", () => {
    expect(resolveVoice("asteria")).toBe("asteria");
    expect(resolveVoice("nope")).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoice(undefined)).toBe(DEFAULT_VOICE_ID);
  });

  it("audioKey lands the WAV beside the shot's render artifacts", () => {
    expect(audioKey("my_film", "shot_03")).toBe("renders/my_film/dialogue/shot_03.wav");
  });

  it("normalizeInput requires a project and an array of lines", () => {
    expect(normalizeInput(undefined as never).ok).toBe(false);
    expect(normalizeInput({ project: "", lines: [] } as never).ok).toBe(false);
    const bad = normalizeInput({ project: "p", lines: {} } as never);
    expect(bad.ok).toBe(false);
  });

  it("normalizeInput skips empty/textless lines and resolves voices", () => {
    const r = normalizeInput({
      project: "p",
      lines: [
        { shot_id: "shot_01", text: "Hello.", voice_id: "orion" },
        { shot_id: "shot_02", text: "   " },          // no words -> skipped
        { shot_id: "", text: "orphan" },              // no shot -> skipped
        { shot_id: "shot_03", text: "Bye.", voice_id: "bogus" }, // unknown voice -> default
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines.map((l) => l.shot_id)).toEqual(["shot_01", "shot_03"]);
      expect(r.lines[0].voice).toBe("orion");
      expect(r.lines[1].voice).toBe(DEFAULT_VOICE_ID);
    }
  });

  it("normalizeInput rejects an over-cap line (no silent truncation of a character's words)", () => {
    const r = normalizeInput({ project: "p", lines: [{ shot_id: "shot_01", text: "x".repeat(301) }] });
    expect(r.ok).toBe(false);
  });
});

describe("dialogue-gen WAV pad/trim", () => {
  it("pads a short line to 3.0s and trims past 15.0s", () => {
    const short = mintSilenceWav(1.5);
    const padded = normalizeLineWav(short);
    expect(padded).not.toBeNull();
    expect(padded!.padded).toBe(true);
    expect(padded!.trimmed).toBe(false);
    expect(padded!.seconds).toBeCloseTo(LINE_WAV_MIN_SECONDS, 5);

    const long = mintSilenceWav(16);
    const trimmed = normalizeLineWav(long);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.trimmed).toBe(true);
    expect(trimmed!.padded).toBe(false);
    expect(trimmed!.seconds).toBeCloseTo(LINE_WAV_MAX_SECONDS, 5);
  });

  it("keeps a legal 4s file and refuses non-WAV bytes", () => {
    const ok = mintSilenceWav(4);
    const kept = normalizeLineWav(ok);
    expect(kept).not.toBeNull();
    expect(kept!.padded).toBe(false);
    expect(kept!.trimmed).toBe(false);
    expect(kept!.seconds).toBeCloseTo(4, 5);
    expect(parseWavDurationSeconds(kept!.bytes)).toBeCloseTo(4, 5);
    expect(normalizeLineWav(new TextEncoder().encode("not a wav"))).toBeNull();
  });
});

// ---- fetch submit/poll lifecycle ------------------------------------------

interface StoredObj { body: string | ArrayBuffer; }

function fakeEnv(opts: { workflowStatus?: string; createThrows?: boolean } = {}) {
  const store = new Map<string, StoredObj>();
  const created: Array<{ id?: string; params?: unknown }> = [];
  const env = {
    GATEWAY_ID: "gw",
    AI: { async run() { throw new Error("AI.run must NOT be called from the request path"); } },
    R2_RENDERS: {
      async put(key: string, value: string | ArrayBuffer) { store.set(key, { body: value }); },
      async get(key: string) {
        const o = store.get(key);
        if (!o) return null;
        return { async text() { return typeof o.body === "string" ? o.body : ""; } };
      },
    },
    DIALOGUE_WORKFLOW: {
      async create(options?: { id?: string; params?: unknown }) {
        if (opts.createThrows) throw new Error("workflow create failed");
        created.push(options ?? {});
        return { id: "wf-1", async status() { return { status: opts.workflowStatus ?? "running" }; } };
      },
      async get(_id: string) {
        return { id: "wf-1", async status() { return { status: opts.workflowStatus ?? "running" }; } };
      },
    },
  };
  return { env, store, created };
}

function req(path: string, body: unknown): Request {
  return new Request("https://module" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
const speaking = { project: "f", lines: [{ shot_id: "shot_01", text: "We should not be here.", voice_id: "orion" }] };

describe("dialogue-gen #155: batch synth runs in a Workflow, not waitUntil", () => {
  it("invoke with lines starts the workflow with the normalized lines and returns a poll token", async () => {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; poll?: string };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
    expect(typeof j.poll).toBe("string");
    expect(created.length).toBe(1);
    const params = created[0].params as { project: string; lines: Array<{ shot_id: string; voice: string }> };
    expect(params.project).toBe("f");
    expect(params.lines[0].voice).toBe("orion");
  });

  it("invoke with NO speaking lines returns an empty result immediately (no workflow)", async () => {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(req("/invoke", { hook: "dialogue", input: { project: "f", lines: [] }, config: {} }), env as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; output?: { audio: unknown[] } };
    expect(j.ok).toBe(true);
    expect(j.pending).toBeUndefined();
    expect(j.output?.audio).toEqual([]);
    expect(created.length).toBe(0);
  });

  it("poll returns pending while the workflow runs (no done state in R2 yet)", async () => {
    const { env } = fakeEnv({ workflowStatus: "running" });
    const inv = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never);
    const j = await out.json() as { ok: boolean; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
  });

  it("poll returns the audio map once the workflow writes the done R2 state", async () => {
    const { env } = fakeEnv();
    const inv = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const jobId = JSON.parse(atob(poll)).job_id;
    await env.R2_RENDERS.put(`dialogue-gen/${jobId}.state.json`, JSON.stringify({
      status: "done", project: "f",
      audio: [{ shot_id: "shot_01", audio_key: "renders/f/dialogue/shot_01.wav", voice_id: "orion" }],
      applied: ["dialogue:@cf/deepgram/aura-1", "lines:1"],
    }));
    const out = await worker.fetch(req("/poll", { poll }), env as never);
    const j = await out.json() as { ok: boolean; output?: { audio: Array<{ audio_key: string }> } };
    expect(j.ok).toBe(true);
    expect(j.output?.audio[0].audio_key).toBe("renders/f/dialogue/shot_01.wav");
  });

  it("poll surfaces an errored workflow as ok:false instead of pending-forever", async () => {
    const { env } = fakeEnv({ workflowStatus: "errored" });
    const inv = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never);
    const j = await out.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/errored/);
  });

  it("invoke surfaces a workflow-create failure as ok:false (failure is data)", async () => {
    const { env } = fakeEnv({ createThrows: true });
    const resp = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const j = await resp.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/workflow/i);
  });
});

// ---- the batch workflow loop ----------------------------------------------

describe("DialogueGenWorkflow.run synthesizes one WAV per shot", () => {
  it("writes a WAV per line via env.AI.run and a done state carrying the audio map", async () => {
    const puts: Array<{ key: string; mime?: string }> = [];
    let aiCalls = 0;
    const env = {
      GATEWAY_ID: "gw",
      AI: {
        async run(_model: string, params: { speaker: string }) {
          aiCalls++;
          return `WAV-for-${params.speaker}`;  // BodyInit string -> non-empty bytes
        },
      },
      R2_RENDERS: {
        store: new Map<string, string>(),
        async put(key: string, v: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
          puts.push({ key, mime: opts?.httpMetadata?.contentType });
          (this.store as Map<string, string>).set(key, typeof v === "string" ? v : "bytes");
        },
        async get(key: string) {
          const s = (this.store as Map<string, string>).get(key);
          return s ? { async text() { return s; } } : null;
        },
      },
      DIALOGUE_WORKFLOW: {} as never,
    };
    const step = { do: async (_n: string, _c: unknown, fn: () => Promise<unknown>) => fn() };
    const wf = new DialogueGenWorkflow(null as never, env as never);
    await wf.run(
      { payload: { job_id: "job-1", project: "f", lines: [
        { shot_id: "shot_01", text: "Hi.", voice: "orion" },
        { shot_id: "shot_02", text: "Bye.", voice: "hera" },
      ] } } as never,
      step as never,
    );

    // Two synths, two WAVs (audio/wav), each at the per-shot key.
    expect(aiCalls).toBe(2);
    const wavPuts = puts.filter((p) => p.key.endsWith(".wav"));
    expect(wavPuts.map((p) => p.key)).toEqual([
      "renders/f/dialogue/shot_01.wav",
      "renders/f/dialogue/shot_02.wav",
    ]);
    expect(wavPuts.every((p) => p.mime === AUDIO_MIME)).toBe(true);

    // Done state written with the audio map + applied tags.
    const stateRaw = await env.R2_RENDERS.get("dialogue-gen/job-1.state.json");
    const state = JSON.parse(await stateRaw!.text()) as { status: string; audio: Array<{ shot_id: string; voice_id: string }>; applied: string[] };
    expect(state.status).toBe("done");
    expect(state.audio.map((a) => a.shot_id)).toEqual(["shot_01", "shot_02"]);
    expect(state.audio[1].voice_id).toBe("hera");
    expect(state.applied).toContain("lines:2");
  });

  it("writes a terminal failed state when a synth throws (failure is recorded, not swallowed)", async () => {
    const env = {
      GATEWAY_ID: "gw",
      AI: { async run() { throw new Error("model down"); } },
      R2_RENDERS: {
        store: new Map<string, string>(),
        async put(key: string, v: string) { (this.store as Map<string, string>).set(key, typeof v === "string" ? v : "x"); },
        async get(key: string) {
          const s = (this.store as Map<string, string>).get(key);
          return s ? { async text() { return s; } } : null;
        },
      },
      DIALOGUE_WORKFLOW: {} as never,
    };
    const step = { do: async (_n: string, _c: unknown, fn: () => Promise<unknown>) => fn() };
    const wf = new DialogueGenWorkflow(null as never, env as never);
    await wf.run({ payload: { job_id: "job-2", project: "f", lines: [{ shot_id: "shot_01", text: "Hi.", voice: "orion" }] } } as never, step as never);
    const stateRaw = await env.R2_RENDERS.get("dialogue-gen/job-2.state.json");
    const state = JSON.parse(await stateRaw!.text()) as { status: string; error: string };
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/model down/);
  });
});

describe("dialogue-gen: each line is brought to one level", () => {
  const RATE = 24000;
  /** A linear16 WAV from segments of [seconds, sine amplitude in dBFS or null for silence]. */
  function wav(segments: Array<[number, number | null]>, bits = 16, spike?: number, channels = 1): Uint8Array {
    const samples: number[] = [];
    for (const [sec, db] of segments) {
      const amp = db === null ? 0 : 10 ** (db / 20) * 32767;
      for (let i = 0; i < Math.round(sec * RATE); i++) {
        for (let c = 0; c < channels; c++) samples.push(Math.round(amp * Math.sin((i * 2 * Math.PI * 220) / RATE)));
      }
    }
    if (spike !== undefined) samples[100] = Math.round(Math.sign(spike) * 10 ** (-Math.abs(spike) / 20) * 32767);
    const blockAlign = (bits / 8) * channels;
    const pcm = new Uint8Array((samples.length * bits) / 8);
    const pv = new DataView(pcm.buffer);
    samples.forEach((s, i) => { if (bits === 16) pv.setInt16(i * 2, s, true); else pv.setUint8(i, 128); });
    const out = new Uint8Array(44 + pcm.length);
    const v = new DataView(out.buffer);
    const put = (o: number, x: string) => { for (let i = 0; i < x.length; i++) out[o + i] = x.charCodeAt(i); };
    put(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); put(8, "WAVE"); put(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, RATE, true); v.setUint32(28, RATE * blockAlign, true);
    v.setUint16(32, blockAlign, true); v.setUint16(34, bits, true); put(36, "data"); v.setUint32(40, pcm.length, true);
    out.set(pcm, 44);
    return out;
  }
  function rmsDb(bytes: Uint8Array, seconds?: number): number {
    const body = bytes.subarray(44);
    const copy = new Uint8Array(body.length); copy.set(body);
    const s = new Int16Array(copy.buffer);
    const n = seconds === undefined ? s.length : Math.round(seconds * RATE);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += s[i] * s[i];
    return 20 * Math.log10(Math.sqrt(sum / n) / 32768);
  }
  const peakDb = (bytes: Uint8Array) => {
    const body = bytes.subarray(44);
    const copy = new Uint8Array(body.length); copy.set(body);
    let p = 0;
    for (const x of new Int16Array(copy.buffer)) p = Math.max(p, Math.abs(x));
    return 20 * Math.log10(p / 32768);
  };

  it("two lines 20 dB apart come out at the same level", () => {
    const a = normalizeLineWav(wav([[4, -36]]))!;
    const b = normalizeLineWav(wav([[4, -16]]))!;
    expect(rmsDb(a.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
    expect(rmsDb(b.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
    expect(a.gain_db).toBeGreaterThan(15);
  });

  it("turns a loud line down too", () => {
    const r = normalizeLineWav(wav([[4, -10]]))!;
    expect(r.gain_db).toBeLessThan(-5);
    expect(rmsDb(r.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });

  it("pauses and the pad after the line do not count as quiet", () => {
    const short = normalizeLineWav(wav([[0.5, -30], [0.5, null], [0.5, -30]]))!;
    const long = normalizeLineWav(wav([[4, -30]]))!;
    expect(short.gain_db).toBeCloseTo(long.gain_db, 0);
    expect(short.padded).toBe(true);
    expect(short.seconds).toBe(LINE_WAV_MIN_SECONDS);
    expect(rmsDb(short.bytes, 0.5)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });

  it("stops at the peak limit, so a loud click does not clip", () => {
    const r = normalizeLineWav(wav([[4, -36]], 16, 3))!;
    expect(peakDb(r.bytes)).toBeLessThanOrEqual(LINE_PEAK_LIMIT_DBFS + 0.1);
    expect(peakDb(r.bytes)).toBeGreaterThan(LINE_PEAK_LIMIT_DBFS - 0.5);
    expect(r.gain_db).toBeLessThan(5);
  });

  it("a faint line stays faint: noise is not made into speech", () => {
    // Sines, so level is 3 dB under peak.
    const out = (peak: number) => rmsDb(normalizeLineWav(wav([[4, peak]]))!.bytes);
    expect(out(-46)).toBeLessThan(LINE_TARGET_DBFS - 15);
    expect(out(-46)).toBeLessThan(out(-42));
    expect(out(-42)).toBeLessThan(out(-37) + 0.01);
    expect(out(-37)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });

  it("has no step anywhere from the gate to full gain", () => {
    let last = -Infinity;
    for (let peak = -60; peak <= -20; peak += 1) {
      const level = rmsDb(normalizeLineWav(wav([[4, peak]]))!.bytes);
      expect(level, `at ${peak}`).toBeGreaterThanOrEqual(last - 0.05);
      if (peak > -60) expect(level - last, `step at ${peak}`).toBeLessThan(5);
      last = level;
    }
    expect(LINE_FULL_GAIN_DBFS).toBeGreaterThan(-50);
  });

  it("a negative click is the peak too", () => {
    const r = normalizeLineWav(wav([[4, -36]], 16, -1.5))!;
    expect(r.gain_db).toBeCloseTo(0.5, 0);
  });

  it("levels several channels the same as one", () => {
    const mono = normalizeLineWav(wav([[4, -30]]))!;
    const stereo = normalizeLineWav(wav([[4, -30]], 16, undefined, 2))!;
    expect(stereo.gain_db).toBeCloseTo(mono.gain_db, 1);
    expect(rmsDb(stereo.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });

  it("a block is 20 ms however many channels: short bursts gate the same", () => {
    const bursts: Array<[number, number | null]> = [];
    for (let i = 0; i < 100; i++) bursts.push([0.015, -30], [0.015, null]);
    const mono = normalizeLineWav(wav(bursts))!;
    const stereo = normalizeLineWav(wav(bursts, 16, undefined, 2))!;
    expect(stereo.gain_db).toBeCloseTo(mono.gain_db, 1);
  });

  it("the gain can be read back from the line and from the module's output", async () => {
    const puts: Array<{ key: string; meta?: Record<string, string> }> = [];
    const store = new Map<string, string>();
    const env = {
      GATEWAY_ID: "gw",
      AI: { run: async () => wav([[4, -36]]) },
      R2_RENDERS: {
        async put(key: string, v: unknown, o?: { customMetadata?: Record<string, string> }) {
          puts.push({ key, meta: o?.customMetadata });
          store.set(key, typeof v === "string" ? v : "bytes");
        },
        async get(key: string) { const s = store.get(key); return s ? { text: async () => s } : null; },
      },
      DIALOGUE_WORKFLOW: {} as never,
    };
    const step = { do: async (_n: string, _c: unknown, fn: () => Promise<unknown>) => fn() };
    await new DialogueGenWorkflow(null as never, env as never).run(
      { payload: { job_id: "j", project: "f", lines: [{ shot_id: "shot_01", text: "Hi.", voice: "orion" }] } } as never,
      step as never,
    );
    const put = puts.find((p) => p.key.endsWith(".wav"))!;
    const state = JSON.parse(store.get("dialogue-gen/j.state.json")!) as { audio: Array<{ gain_db: number }> };
    expect(state.audio[0].gain_db).toBeGreaterThan(15);
    expect(put.meta?.gain_db).toBe(state.audio[0].gain_db.toFixed(2));
  });

  it("a click in audio that is trimmed away does not set the gain", () => {
    const w = wav([[15, -36], [2, -36]]);
    const copy = new Uint8Array(w);
    new DataView(copy.buffer).setInt16(44 + 16 * RATE * 2, 32000, true);
    const r = normalizeLineWav(copy)!;
    expect(r.trimmed).toBe(true);
    expect(rmsDb(r.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });

  it("below the gate there is no speech, and a silent line stays as it was", () => {
    const silent = wav([[4, null]]);
    const r = normalizeLineWav(silent)!;
    expect(r.gain_db).toBe(0);
    expect(r.bytes).toBe(silent);
    expect(normalizeLineWav(wav([[4, -60]]))!.gain_db).toBe(0);
  });

  it("leaves a depth it cannot level alone", () => {
    const eight = wav([[4, -20]], 8);
    const r = normalizeLineWav(eight)!;
    expect(r.gain_db).toBe(0);
    expect(r.bytes).toBe(eight);
  });

  it("reads a WAV that is not aligned in its buffer", () => {
    const w = wav([[4, -36]]);
    const shifted = new Uint8Array(w.length + 1);
    shifted.set(w, 1);
    const r = normalizeLineWav(shifted.subarray(1))!;
    expect(rmsDb(r.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });

  it("a line over the cap is still trimmed, and leveled", () => {
    const r = normalizeLineWav(wav([[16, -36]]))!;
    expect(r.trimmed).toBe(true);
    expect(r.seconds).toBe(LINE_WAV_MAX_SECONDS);
    expect(rmsDb(r.bytes)).toBeCloseTo(LINE_TARGET_DBFS, 0);
  });
});

