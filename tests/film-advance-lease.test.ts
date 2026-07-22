import { describe, it, expect } from "vitest";
import { claimFilmAdvance, releaseFilmAdvance, FILM_ADVANCE_LEASE_TTL_SECONDS } from "@skyphusion-labs/vivijure-core/renders-db";
import { advanceFilmJob, filmJobDocKey, type FilmJob, type FinishShot } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { Env } from "../src/env";
import { orch } from "./orchestrator-env";

// S4: the film-advance lease. advanceFilmJob is driven concurrently by the 1-minute cron sweep
// and every client status poll; both do an unlocked read-modify-write on the R2 film-job doc, so
// two racers could each observe phase N incomplete and BOTH submit the underlying external work
// (clip start / dialogue / per-shot finish steps / mux) -- duplicated GPU spend. The lease
// (claimFilmAdvance, the claimFinish conditional-UPDATE pattern) makes exactly ONE driver advance
// a film per tick; the loser reads the doc read-only.

// A fake D1 implementing the lease SQL semantics atomically (each run() has no internal await, so
// it is atomic under JS concurrency exactly as a single D1 UPDATE is under SQLite's writer lock).
function leaseDb(jobIds: string[]) {
  const rows = new Map<string, { advance_lease: number | null; advance_lease_token: string | null }>(
    jobIds.map((id) => [id, { advance_lease: null, advance_lease_token: null }]),
  );
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              // Release: `SET advance_lease = NULL, advance_lease_token = NULL WHERE job_id=? AND
              // advance_lease_token=?` -- keyed on the TOKEN, so a stale token clears nothing. (Checked
              // first: the release SQL also contains "SET advance_lease".)
              if (sql.includes("advance_lease = NULL")) {
                const [jobId, token] = args as [string, string];
                const r = rows.get(jobId);
                if (r && r.advance_lease_token !== null && r.advance_lease_token === token) {
                  r.advance_lease = null;
                  r.advance_lease_token = null;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              // Claim: `SET advance_lease=?, advance_lease_token=? WHERE job_id=? AND (advance_lease IS
              // NULL OR advance_lease < ? OR advance_lease_token = ?)`. The token appears twice (SET +
              // the idempotency predicate); both binds are the SAME value.
              if (sql.includes("SET advance_lease")) {
                const [lease, token, jobId, now, tokenPred] = args as [number, string, string, number, string];
                const r = rows.get(jobId);
                // Honor the SQL as written: the #29 idempotency clause is only in effect if the claim
                // SQL actually contains it (so a pre-fix predicate can be simulated by dropping it).
                const tokenClause =
                  sql.includes("OR advance_lease_token = ?") &&
                  r != null &&
                  r.advance_lease_token !== null &&
                  r.advance_lease_token === tokenPred;
                if (r && (r.advance_lease === null || r.advance_lease < now || tokenClause)) {
                  r.advance_lease = lease;
                  r.advance_lease_token = token;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
            first: async () => (rows.has(args[0] as string) ? { one: 1 } : null),
          };
        },
      };
    },
  };
  return { DB, rows };
}

describe("claimFilmAdvance / releaseFilmAdvance (win / lose / reset)", () => {
  const id = "film-lease-unit";

  it("first claim wins with a lease token; a concurrent second claim loses", async () => {
    const { DB } = leaseDb([id]);
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(orch(env), id, 1000);
    expect(a.won).toBe(true);
    expect(a.lease).toBe(1000 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000);
    expect(typeof a.token).toBe("string"); // #29: a unique per-claim leaseholder identity
    const b = await claimFilmAdvance(orch(env), id, 1001);
    expect(b.won).toBe(false);
    expect(b.lease).toBeUndefined();
    expect(b.token).toBeUndefined();
  });

  it("release (by token) makes the lease re-grantable; a stale token releases nothing", async () => {
    const { DB, rows } = leaseDb([id]);
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(orch(env), id, 1000);
    await releaseFilmAdvance(orch(env), id, "not-my-token"); // stale token: no-op
    expect(rows.get(id)?.advance_lease).toBe(a.lease);
    await releaseFilmAdvance(orch(env), id, a.token as string);
    expect(rows.get(id)?.advance_lease).toBeNull();
    const b = await claimFilmAdvance(orch(env), id, 2000);
    expect(b.won).toBe(true); // genuine retry after a released tick is never deadlocked
  });

  it("#29: a LOST response after the claim commits still returns a win on retry (no stall)", async () => {
    const { rows } = leaseDb([id]);
    let claimRuns = 0;
    const DB = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                if (sql.includes("SET advance_lease") && !sql.includes("advance_lease = NULL")) {
                  const [lease, token, jobId, now, tokenPred] = args as [number, string, string, number, string];
                  const r = rows.get(jobId)!;
                  const tokenClause = sql.includes("OR advance_lease_token = ?") && r.advance_lease_token === tokenPred;
                  const matched = r.advance_lease === null || r.advance_lease < now || tokenClause;
                  if (matched) {
                    r.advance_lease = lease;
                    r.advance_lease_token = token;
                  }
                  claimRuns += 1;
                  if (claimRuns === 1) throw new Error("network connection lost");
                  return { meta: { changes: matched ? 1 : 0 } };
                }
                return { meta: { changes: 0 } };
              },
              first: async () => (rows.has(args[0] as string) ? { one: 1 } : null),
            };
          },
        };
      },
    };
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(orch(env), id, 1000);
    expect(claimRuns).toBe(2);
    expect(a.won).toBe(true);
    expect(a.token).toBe(rows.get(id)?.advance_lease_token);
  });

  it("an EXPIRED lease is re-grantable (a crashed winner never wedges the job)", async () => {
    const { DB } = leaseDb([id]);
    const env = { DB } as unknown as Env;
    const t0 = 1000;
    const a = await claimFilmAdvance(orch(env), id, t0);
    expect(a.won).toBe(true);
    const before = await claimFilmAdvance(orch(env), id, t0 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000 - 1);
    expect(before.won).toBe(false);
    const after = await claimFilmAdvance(orch(env), id, t0 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000 + 1);
    expect(after.won).toBe(true);
  });

  it("no renders row at all: wins UNGUARDED (no token) -- a legacy/untracked film must not deadlock", async () => {
    const { DB } = leaseDb([]);
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(orch(env), "film-no-row", 1000);
    expect(a.won).toBe(true);
    expect(a.lease).toBeUndefined();
    expect(a.token).toBeUndefined();
  });
});

describe("advanceFilmJob under the lease: two concurrent drivers, ONE submission", () => {
  const filmId = "film-lease-race";

  const finishFilm = (): FilmJob => ({
    film_id: filmId, project: "neon", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "finish", clips_only: true,
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4", chain: ["MODULE_FINISH_LIPSYNC"], configs: [{}], idx: 0, status: "pending", applied: [] },
    ] as FinishShot[],
    created_at: Date.now(),
  });

  function raceEnv(job: FilmJob) {
    const docKey = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    let puts = 0;
    const calls = { invoke: 0, poll: 0 };
    const { DB, rows } = leaseDb([job.film_id]);
    const env = {
      DB,
      R2_RENDERS: {
        get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
        put: async (k: string, b: string) => { if (k === docKey) { stored = b; puts += 1; } },
        list: async () => ({ objects: [], truncated: false }),
        head: async () => null,
      },
      MODULE_FINISH_LIPSYNC: {
        fetch: async (url: string) => {
          if (String(url).includes("/module.json")) {
            return new Response(JSON.stringify({ name: "finish-lipsync", version: "0.1.0", api: "vivijure-module/2", hooks: ["finish"] }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (String(url).includes("/invoke")) {
            calls.invoke += 1;
            return new Response(JSON.stringify({ ok: true, pending: true, poll: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
          }
          calls.poll += 1;
          return new Response(JSON.stringify({ ok: true, pending: true, poll: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    } as unknown as Env;
    return { env, calls, rows, read: () => JSON.parse(stored) as FilmJob, putCount: () => puts };
  }

  it("two CONCURRENT advances submit the lip-sync job exactly once; the loser still reports the job", async () => {
    const { env, calls, rows, read } = raceEnv(finishFilm());
    const [a, b] = await Promise.all([advanceFilmJob(orch(env), filmId), advanceFilmJob(orch(env), filmId)]);
    expect(calls.invoke).toBe(1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(read().finish_shots?.[0].poll).toBe("tok-1");
    expect(rows.get(filmId)?.advance_lease).toBeNull();
  });

  it("the released lease lets the NEXT tick advance (poll the parked job) -- no deadlock after a win", async () => {
    const { env, calls } = raceEnv(finishFilm());
    await Promise.all([advanceFilmJob(orch(env), filmId), advanceFilmJob(orch(env), filmId)]);
    await advanceFilmJob(orch(env), filmId);
    expect(calls.invoke).toBe(1);
    expect(calls.poll).toBe(1);
  });

  it("the LOSER writes nothing (its stale doc state can never clobber the winner's)", async () => {
    const { env, putCount } = raceEnv(finishFilm());
    const before = putCount();
    const results = await Promise.all([advanceFilmJob(orch(env), filmId), advanceFilmJob(orch(env), filmId)]);
    expect(results.every((r) => r !== null)).toBe(true);
    const winnerWrites = putCount() - before;
    const { env: soloEnv, putCount: soloPuts } = raceEnv(finishFilm());
    await advanceFilmJob(orch(soloEnv), filmId);
    expect(winnerWrites).toBe(soloPuts());
  });
});
