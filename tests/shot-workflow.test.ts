import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readShot, writeShot, type ShotDb } from "../src/shot-record";
import { openShot, runShot, type ShotIo, type StepDo } from "../src/shot-workflow";
import {
  carriesR2Credential,
  envForTenantOrDispatch,
  type ShotParams,
  type ShotRecord,
} from "../src/shot-step";

function params(over: Partial<ShotParams> = {}): ShotParams {
  return {
    film_id: "film-1",
    shot_id: "shot_01",
    still_key: "renders/p/shot_01.png",
    needs_wav: true,
    wav_key: null,
    clip_key: null,
    still_url: "https://r2.example/still?sig=1",
    wav_url: "https://r2.example/wav?sig=1",
    ...over,
  };
}

function memoryDb(): ShotDb & { rows: Map<string, ShotRecord> } {
  const rows = new Map<string, ShotRecord>();
  return {
    rows,
    prepare(sql: string) {
      const write = sql.trim().startsWith("INSERT");
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              const key = `${args[0]}\0${args[1]}`;
              return (rows.get(key) as T | undefined) ?? null;
            },
            async run() {
              if (!write) return;
              const row: ShotRecord = {
                film_id: String(args[0]),
                shot_id: String(args[1]),
                still_key: (args[2] as string | null) ?? null,
                wav_key: (args[3] as string | null) ?? null,
                clip_key: (args[4] as string | null) ?? null,
                step: args[5] as ShotRecord["step"],
                step_error: (args[6] as string | null) ?? null,
                step_token: (args[7] as string | null) ?? null,
                updated_at: Number(args[8]),
              };
              rows.set(`${row.film_id}\0${row.shot_id}`, row);
            },
          };
        },
      };
    },
  };
}

function cachingDo(): { stepDo: StepDo; ran: string[] } {
  const cache = new Map<string, unknown>();
  const ran: string[] = [];
  const stepDo: StepDo = async (name, fn) => {
    if (cache.has(name)) return cache.get(name) as never;
    ran.push(name);
    const value = await fn();
    cache.set(name, value);
    return value;
  };
  return { stepDo, ran };
}

function io(db: ShotDb, over: Partial<ShotIo> = {}): ShotIo & { wavs: number; clips: ClipSeen[] } {
  const seen = { wavs: 0, clips: [] as ClipSeen[] };
  const base: ShotIo = {
    now: () => 100,
    read: (filmId, shotId) => readShot(db, filmId, shotId),
    write: (row) => writeShot(db, row),
    startWav: async (row) => {
      seen.wavs += 1;
      expect(carriesR2Credential(row)).toBe(false);
      return { key: "renders/p/shot_01.wav" };
    },
    startClip: async (call, row) => {
      seen.clips.push({ call, row });
      expect(carriesR2Credential(call)).toBe(false);
      expect(carriesR2Credential(row)).toBe(false);
      return { key: "renders/p/shot_01.mp4" };
    },
  };
  return {
    ...base,
    ...over,
    get wavs() { return seen.wavs; },
    get clips() { return seen.clips; },
  };
}

interface ClipSeen {
  call: { still_url: string; wav_url?: string };
  row: ShotRecord;
}

describe("shot workflow", () => {
  it("a failed clip retries the clip and does not run the wav again", async () => {
    const db = memoryDb();
    let clipFails = true;
    const book = io(db, {
      startClip: async (call) => {
        expect(call.still_url).toBe("https://r2.example/still?sig=1");
        expect(call.wav_url).toBe("https://r2.example/wav?sig=1");
        expect(Object.keys(call).sort()).toEqual(["still_url", "wav_url"]);
        if (clipFails) throw new Error("clip vendor failed");
        return { key: "renders/p/shot_01.mp4" };
      },
    });
    const first = cachingDo();
    await expect(runShot(params(), book, first.stepDo)).rejects.toThrow(/clip vendor failed/);
    expect(book.wavs).toBe(1);
    const saved = await readShot(db, "film-1", "shot_01");
    expect(saved?.still_key).toBe("renders/p/shot_01.png");
    expect(saved?.wav_key).toBe("renders/p/shot_01.wav");
    expect(saved?.clip_key).toBeNull();
    expect(saved?.step).toBe("clip");
    expect(saved?.step_error).toBe("clip vendor failed");

    clipFails = false;
    const second = cachingDo();
    // The second instance sees the row. still and wav keys are set, so those
    // starters do not run. The clip step is the one that runs.
    const wavsBefore = book.wavs;
    const done = await runShot(params(), book, second.stepDo);
    expect(book.wavs).toBe(wavsBefore);
    expect(done.step).toBe("done");
    expect(done.clip_key).toBe("renders/p/shot_01.mp4");
    expect(second.ran).toEqual(["record", "still", "wav", "clip"]);
  });

  it("a silent shot does not start a wav", async () => {
    const db = memoryDb();
    const book = io(db);
    const { stepDo } = cachingDo();
    const done = await runShot(params({ needs_wav: false, wav_url: null }), book, stepDo);
    expect(book.wavs).toBe(0);
    expect(done.wav_key).toBeNull();
    expect(done.clip_key).toBe("renders/p/shot_01.mp4");
    expect(book.clips[0].call.wav_url).toBeUndefined();
  });

  it("a missing still fails the still and does not start the clip", async () => {
    const db = memoryDb();
    const book = io(db);
    const { stepDo } = cachingDo();
    await expect(runShot(params({ still_key: null }), book, stepDo)).rejects.toThrow(/still is not in R2/);
    expect(book.wavs).toBe(0);
    expect(book.clips).toHaveLength(0);
    const saved = await readShot(db, "film-1", "shot_01");
    expect(saved?.step).toBe("still");
    expect(saved?.step_error).toBe("still is not in R2");
  });

  it("strips the R2 credential before a tenant or dispatch env is handed out", () => {
    const env = envForTenantOrDispatch({
      R2_RENDERS: { put: true },
      R2_S3_ACCESS_KEY_ID: "tok",
      R2_S3_SECRET_ACCESS_KEY: "deadbeef",
      MODULE_DISPATCH: { get: true },
    });
    expect(env.R2_RENDERS).toEqual({ put: true });
    expect(env.MODULE_DISPATCH).toEqual({ get: true });
    expect("R2_S3_ACCESS_KEY_ID" in env).toBe(false);
    expect("R2_S3_SECRET_ACCESS_KEY" in env).toBe(false);
    expect(carriesR2Credential(env)).toBe(false);
  });

  it("openShot refuses to pass an R2 credential into the workflow params", async () => {
    let seen: unknown;
    const opened = await openShot(
      {
        SHOT_WORKFLOW: {
          async create(options) {
            seen = options?.params;
            return { id: "shot-wf-1" };
          },
          async get() {
            return { id: "shot-wf-1", status: async () => ({ status: "queued" }) };
          },
        },
      },
      { ...params(), secret_access_key: "deadbeef" } as ShotParams & { secret_access_key: string },
    );
    expect(opened).toEqual({ ok: true, id: "shot-wf-1" });
    expect(carriesR2Credential(seen)).toBe(false);
  });

  it("does not construct a vendor workflow or buffer an MP4", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "shot-workflow.ts"), "utf8");
    expect(src).not.toContain("DialogueGenWorkflow");
    expect(src).not.toContain("CfHailuoWorkflow");
    expect(src).not.toContain("CfSeedanceWorkflow");
    expect(src).not.toContain("arrayBuffer");
    expect(src).not.toContain(".get(");
  });
});
