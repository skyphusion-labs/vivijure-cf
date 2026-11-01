// Storage and platform wiring for film-parent.ts. No decisions live here.

import { FINISH_AFFINITY_HEADER } from "./video-finish-binding";
import { presignR2Get, presignR2Put, FILM_DOWNLOAD_TTL_SECONDS } from "./r2-presign";
import { mediaFinishHeaders, videoFinishFetch } from "@skyphusion-labs/vivijure-core";
import { JoinTransient } from "./film-parent";
import type { StudioEnv } from "./orchestrator-env";
import {
  FILM_PARENT_ACTIVE_PREFIX,
  FILM_PARENT_LIST_PREFIX,
  FILM_PARENT_PREFIX,
  type ChildRead,
  type JoinRead,
  type ParentDeps,
  type ParentDoc,
} from "./film-parent";

const docKey = (id: string) => `${FILM_PARENT_PREFIX}${id}.json`;
const activeKey = (id: string) => `${FILM_PARENT_ACTIVE_PREFIX}${id}`;
// R2 lists in key order, so the time is inverted to list newest first, and padded so it sorts as text.
const listKey = (id: string, createdAt: number) =>
  `${FILM_PARENT_LIST_PREFIX}${String(9_999_999_999_999 - createdAt).padStart(13, "0")}-${id}`;

export interface LoadedParent {
  doc: ParentDoc;
  etag: string;
}

export async function loadParent(env: StudioEnv, id: string): Promise<LoadedParent | null> {
  const object = await env.R2_RENDERS.get(docKey(id));
  if (!object) return null;
  return { doc: (await object.json()) as ParentDoc, etag: object.etag };
}

/** Writes only if the doc is new. False means this id already exists. */
export async function insertParent(env: StudioEnv, doc: ParentDoc): Promise<boolean> {
  // Checked first, or a repeat create would put a finished film back on the cron list.
  if (await env.R2_RENDERS.head(docKey(doc.film_id))) return false;
  // The marker first: a crash between the two leaves a marker with no doc, which a sweep clears, and never a
  // parent the cron cannot see.
  await env.R2_RENDERS.put(activeKey(doc.film_id), "");
  const written = await env.R2_RENDERS.put(docKey(doc.film_id), JSON.stringify(doc), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (!written) return false;
  // After the doc: a row with no doc would read as a film that is not there. A crash here leaves a film that
  // is off the list and still works by its id.
  await env.R2_RENDERS.put(listKey(doc.film_id, doc.created_at), "");
  return true;
}

/** Writes if nobody wrote since `loaded` was read, and moves `loaded.etag` on. A parent that can act
 *  again keeps its cron marker; one that cannot drops it. Retry puts it back. */
export async function saveParent(env: StudioEnv, loaded: LoadedParent): Promise<boolean> {
  const written = await env.R2_RENDERS.put(docKey(loaded.doc.film_id), JSON.stringify(loaded.doc), {
    onlyIf: { etagMatches: loaded.etag },
    httpMetadata: { contentType: "application/json" },
  });
  if (!written) return false;
  loaded.etag = written.etag;
  const { phase, parts } = loaded.doc;
  const live = parts.some((p) => p.status === "running" || p.status === "submitting");
  const idle = phase === "done" || phase === "failed" || (phase === "stopped" && !live);
  if (idle) await env.R2_RENDERS.delete(activeKey(loaded.doc.film_id));
  else await env.R2_RENDERS.put(activeKey(loaded.doc.film_id), "");
  return true;
}

export async function listActiveParents(env: StudioEnv, limit: number): Promise<Array<{ id: string; markedAt: number }>> {
  const listed = await env.R2_RENDERS.list({ prefix: FILM_PARENT_ACTIVE_PREFIX, limit });
  return listed.objects.map((o) => ({
    id: o.key.slice(FILM_PARENT_ACTIVE_PREFIX.length),
    markedAt: o.uploaded instanceof Date ? o.uploaded.getTime() : 0,
  }));
}

/** Newest first. Reads each doc and advances nothing. */
export async function listParents(env: StudioEnv, limit: number): Promise<ParentDoc[]> {
  const listed = await env.R2_RENDERS.list({ prefix: FILM_PARENT_LIST_PREFIX, limit });
  const ids = listed.objects.map((o) => o.key.slice(o.key.indexOf("-", FILM_PARENT_LIST_PREFIX.length) + 1));
  const loaded = await Promise.all(ids.map((id) => loadParent(env, id)));
  return loaded.flatMap((l) => (l ? [l.doc] : []));
}

export async function clearActiveMarker(env: StudioEnv, id: string): Promise<void> {
  await env.R2_RENDERS.delete(activeKey(id));
}

/** Calls to the studio's own doors, so a part goes through the same checks as any other film. */
export interface ParentDoors {
  bundle(args: { storyboard: Record<string, unknown>; characterRefs: Record<string, unknown> }): Promise<string>;
  start(body: Record<string, unknown>): Promise<string>;
  startRetake: ParentDeps["startRetake"];
  admitSubmit(): Promise<string | null>;
  pollFilm(filmId: string): Promise<Record<string, unknown> | null>;
}

function childFromPoll(poll: Record<string, unknown>): ChildRead {
  const clips = poll.clips as { done?: number } | undefined;
  const finish = poll.film_finish as { sidecar_key?: string } | undefined;
  return {
    phase: String(poll.phase ?? ""),
    shots_done: typeof clips?.done === "number" ? clips.done : 0,
    output_key: typeof poll.film_key === "string" ? poll.film_key : null,
    sidecar_key: finish?.sidecar_key ?? (typeof poll.sidecar_key === "string" ? poll.sidecar_key : null),
    error: typeof poll.error === "string" ? poll.error : null,
  };
}

// Film URLs must outlive the longest join: 3x the film with a 20 minute floor, plus 30 minutes to upload.
const JOIN_URL_TTL_SECONDS = FILM_DOWNLOAD_TTL_SECONDS;

export function parentDeps(env: StudioEnv, loaded: LoadedParent, doors: ParentDoors): ParentDeps {
  return {
    save: () => saveParent(env, loaded),
    async reload() {
      const fresh = await loadParent(env, loaded.doc.film_id);
      if (!fresh) return null;
      loaded.etag = fresh.etag;
      return fresh.doc;
    },
    admitSubmit: doors.admitSubmit,
    async findChild(project, sinceMs) {
      // submitted_at is whole seconds, so round down or a film from the claim's own second is missed.
      const row = await env.DB.prepare(
        "SELECT job_id FROM renders WHERE project = ? AND job_id LIKE 'film-%' AND submitted_at >= ? ORDER BY submitted_at DESC LIMIT 1",
      ).bind(project, Math.floor(sinceMs / 1000)).first<{ job_id: string }>();
      return row?.job_id ?? null;
    },
    bundle: doors.bundle,
    start: doors.start,
    startRetake: doors.startRetake,
    async readChild(filmId) {
      const poll = await doors.pollFilm(filmId);
      return poll ? childFromPoll(poll) : null;
    },
    async submitJoin(doc, filmKeys, outputKey) {
      const films = await Promise.all(filmKeys.map(async (key) => ({
        url: await presignR2Get(env, key, JOIN_URL_TTL_SECONDS),
      })));
      const outputUrl = await presignR2Put(env, outputKey, JOIN_URL_TTL_SECONDS);
      const resp = await videoFinishFetch(env, "/async/join-films", {
        method: "POST",
        headers: { ...(await mediaFinishHeaders(env)), [FINISH_AFFINITY_HEADER]: doc.film_id },
        body: JSON.stringify({ films, outputUrl, outputKey }),
      });
      if (!resp) throw new JoinTransient("the video-finish door is not reachable");
      const body = (await resp.json().catch(() => null)) as { jobId?: string; error?: string } | null;
      if (resp.status !== 202 || !body?.jobId) {
        const message = `join refused (${resp.status}): ${body?.error ?? "no job id"}`;
        // A full door's 429 is the one answer a caller may wait on, and a 5xx is the door and not the films.
        if (resp.status === 429 || resp.status >= 500) throw new JoinTransient(message);
        throw new Error(message);
      }
      return body.jobId;
    },
    async readJoin(doc, jobId): Promise<JoinRead> {
      const resp = await videoFinishFetch(env, `/async/status/${encodeURIComponent(jobId)}`, {
        headers: { ...(await mediaFinishHeaders(env)), [FINISH_AFFINITY_HEADER]: doc.film_id },
      });
      if (!resp || resp.status === 524 || resp.status === 502 || resp.status === 503 || resp.status === 504) {
        return { status: "pending" };
      }
      if (resp.status === 404) return { status: "missing" };
      // A wrong token never clears by waiting.
      if (resp.status === 401 || resp.status === 403) return { status: "error", error: `join status refused (${resp.status})` };
      const body = (await resp.json().catch(() => null)) as {
        status?: string; error?: string;
        result?: { bytes?: number; durationSeconds?: number; filmOffsetsSeconds?: number[] };
      } | null;
      if (body?.status === "completed" && body.result?.filmOffsetsSeconds) {
        return {
          status: "completed",
          bytes: body.result.bytes ?? 0,
          durationSeconds: body.result.durationSeconds ?? 0,
          filmOffsetsSeconds: body.result.filmOffsetsSeconds,
        };
      }
      if (body?.status === "failed") return { status: "failed", error: body.error ?? "the join failed" };
      if (body?.status === "not_found") return { status: "missing" };
      return { status: "pending" };
    },
    async readText(key) {
      const object = await env.R2_RENDERS.get(key);
      return object ? object.text() : null;
    },
    async writeText(key, text) {
      await env.R2_RENDERS.put(key, text, { httpMetadata: { contentType: "application/x-subrip" } });
    },
  };
}
