// One shot, three steps (still, wav, clip). A failed step is the one that runs again.
//
// Vendor modules that already run inside a Workflow (dialogue-gen, the cf-* catalog
// doors, music-gen, chatterbox) keep that workflow. This class does not construct
// those classes and does not call their vendor HTTP. It records the R2 key. A step
// whose key is missing throws, and the Workflow retries that step. The film poll
// remains the orchestrator that already starts those vendor calls.
//
// The studio worker does not read the MP4 into memory. The clip call is a presigned
// URL. A step with no key yet throws, and the Workflow retries that step.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import type { Env } from "./env";
import { readShot, writeShot, type ShotDb } from "./shot-record";
import {
  blankShot,
  clipCall,
  failStep,
  landKey,
  mergeShot,
  withoutR2Credential,
  type ClipCall,
  type ShotParams,
  type ShotRecord,
  type ShotStepName,
} from "./shot-step";

export interface ShotStarterResult {
  key?: string;
  token?: string;
}

export interface ShotIo {
  now(): number;
  read(filmId: string, shotId: string): Promise<ShotRecord | null>;
  write(row: ShotRecord): Promise<void>;
  /** The existing dialogue module. Absent when this shot has no line. */
  startWav?(row: ShotRecord): Promise<ShotStarterResult>;
  /** The existing catalog or GPU module. The call is URLs only. */
  startClip(call: ClipCall, row: ShotRecord): Promise<ShotStarterResult>;
}

export type StepDo = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** One attempt is short. The row is what a later instance reads, and a throw retries this step. */
const SHOT_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

/**
 * WorkflowStep.do checkpoints a serializable value and passes a step context the
 * caller does not use. The shot steps return a ShotRecord. The cast is that record.
 */
function workflowSteps(step: WorkflowStep): StepDo {
  return (name, fn) => step.do(name, SHOT_STEP_CONFIG, async () => {
    const value = await fn();
    return value as ShotRecord;
  }) as ReturnType<typeof fn>;
}

async function current(io: ShotIo, params: ShotParams, fallback: ShotRecord): Promise<ShotRecord> {
  return (await io.read(params.film_id, params.shot_id)) ?? fallback;
}

async function throwFailed(io: ShotIo, row: ShotRecord, step: ShotStepName, error: string): Promise<never> {
  const failed = failStep(row, step, error, io.now());
  await io.write(failed);
  throw new Error(error);
}

/** Run the three steps. step.do is the Workflow checkpoint: a throw retries that step. */
export async function runShot(params: ShotParams, io: ShotIo, stepDo: StepDo): Promise<ShotRecord> {
  const recorded = await stepDo("record", async () => {
    const existing = await io.read(params.film_id, params.shot_id);
    const row = existing ? mergeShot(existing, params, io.now()) : blankShot(params, io.now());
    await io.write(row);
    return row;
  });

  const stilled = await stepDo("still", async () => {
    const row = await current(io, params, recorded);
    if (row.still_key) return row;
    const key = params.still_key;
    if (!key) return throwFailed(io, row, "still", "still is not in R2");
    const next = landKey(row, "still", key, io.now());
    await io.write(next);
    return next;
  });

  const voiced = await stepDo("wav", async () => {
    const row = await current(io, params, stilled);
    if (!params.needs_wav || row.wav_key) return row;
    if (!io.startWav) return throwFailed(io, row, "wav", "wav is not in R2");
    // The row handed across carries no R2 credential. A tenant or dispatch module
    // must not receive one.
    let started: ShotStarterResult;
    try {
      started = await io.startWav(withoutR2Credential(row));
    } catch (e) {
      return throwFailed(io, row, "wav", (e as Error).message);
    }
    if (!started.key) {
      const pending = failStep(row, "wav", "wav is not ready", io.now());
      pending.step_token = started.token ?? row.step_token;
      await io.write(pending);
      throw new Error("wav is not ready");
    }
    const next = landKey(row, "wav", started.key, io.now());
    await io.write(next);
    return next;
  });

  return stepDo("clip", async () => {
    const row = await current(io, params, voiced);
    if (row.clip_key) {
      const done: ShotRecord = { ...row, step: "done", step_error: null, step_token: null, updated_at: io.now() };
      await io.write(done);
      return done;
    }
    if (!row.still_key || !params.still_url) {
      return throwFailed(io, row, "clip", "clip has no presigned still url");
    }
    if (params.needs_wav && !row.wav_key) {
      return throwFailed(io, row, "clip", "clip is waiting on the wav");
    }
    const call = clipCall(params.still_url, params.needs_wav ? params.wav_url ?? undefined : undefined);
    let started: ShotStarterResult;
    try {
      started = await io.startClip(call, withoutR2Credential(row));
    } catch (e) {
      return throwFailed(io, row, "clip", (e as Error).message);
    }
    if (!started.key) {
      const pending = failStep(row, "clip", "clip is not ready", io.now());
      pending.step_token = started.token ?? row.step_token;
      await io.write(pending);
      throw new Error("clip is not ready");
    }
    const done = landKey(row, "clip", started.key, io.now());
    done.step = "done";
    await io.write(done);
    return done;
  });
}

interface WorkflowBinding {
  create(options?: { id?: string; params?: ShotParams }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string; status(): Promise<{ status: string }> }>;
}

export async function openShot(
  env: { SHOT_WORKFLOW?: WorkflowBinding },
  params: ShotParams,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!env.SHOT_WORKFLOW) return { ok: false, error: "shot workflow is not bound" };
  const instance = await env.SHOT_WORKFLOW.create({ params: withoutR2Credential(params) });
  return { ok: true, id: instance.id };
}

export class ShotWorkflow extends WorkflowEntrypoint<Env, ShotParams> {
  async run(event: WorkflowEvent<ShotParams>, step: WorkflowStep): Promise<ShotRecord> {
    const db = this.env.DB as unknown as ShotDb;
    return runShot(event.payload, {
      now: () => Math.floor(Date.now() / 1000),
      read: (filmId, shotId) => readShot(db, filmId, shotId),
      write: (row) => writeShot(db, row),
      // No vendor workflow is constructed here. A missing key fails this step so
      // the Workflow retries it. The module that already owns the vendor call is
      // what writes the object.
      startClip: async () => ({ }),
    }, workflowSteps(step));
  }
}
