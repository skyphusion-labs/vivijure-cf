// fleet-chezmoi#1662: a lone video-finish 404 past 30s is a peer, not a restart.
//
// The previous suite mocked /async/status/ with ONE responder, so it could not
// produce a wrong-replica 404. This file is the fixture that can: 3 backends,
// 1 holds the job, 2 return 404. The old rule fails on the first peer 404 past
// 30s. The new rule keeps polling until it hits the holder (or the named streak
// / 90-min deadline).

import { describe, it, expect } from "vitest";
import {
  classifyVideoFinish404,
  legacyClassifyVideoFinish404,
  nextNotFoundStreak,
  parseNotFoundStreak,
  CONTAINER_NOTFOUND_GRACE_MS,
  CONTAINER_NOTFOUND_STREAK,
  CONTAINER_NOTFOUND_DEADLINE_MS,
  type VideoFinish404Input,
  type VideoFinish404Verdict,
} from "../modules/_shared/video-finish-404";
import {
  encodePoll as encodeSubtitlePoll,
  decodePoll as decodeSubtitlePoll,
} from "../modules/subtitle/src/subtitle";
import {
  encodePoll as encodeTitlesPoll,
  decodePoll as decodeTitlesPoll,
} from "../modules/film-titles/src/film-titles";
import subtitleWorker from "../modules/subtitle/src/index";
import titlesWorker from "../modules/film-titles/src/index";
import type { FilmFinishInput as SubtitleInput } from "../modules/subtitle/src/contract";
import type { FilmFinishInput as TitlesInput } from "../modules/film-titles/src/contract";

const T0 = 1_700_000_000_000;
const PAST_GRACE = T0 + CONTAINER_NOTFOUND_GRACE_MS + 1;
const PAST_DEADLINE = T0 + CONTAINER_NOTFOUND_DEADLINE_MS;

describe("classifyVideoFinish404 (pure)", () => {
  it("the CURRENT (old) rule fails a single 404 past 30s -- that is the defect", () => {
    expect(legacyClassifyVideoFinish404(T0, PAST_GRACE)).toBe("fail");
    expect(legacyClassifyVideoFinish404(null, T0)).toBe("fail");
  });

  it("the NEW rule keeps a single 404 past 30s pending", () => {
    const input: VideoFinish404Input = { consecutiveNotFound: 1, submittedAt: T0, now: PAST_GRACE };
    expect(classifyVideoFinish404(input)).toBe("pending");
    expect(legacyClassifyVideoFinish404(input.submittedAt, input.now)).toBe("fail");
  });

  it("N=3 consecutive 404s stay pending -- (2/3)^3 = 8/27 ≈ 29.6% is the same defect", () => {
    expect(classifyVideoFinish404({ consecutiveNotFound: 3, submittedAt: T0, now: PAST_GRACE })).toBe("pending");
  });

  it("N=12 consecutive 404s are terminal: (2/3)^12 = 4096/531441 ≈ 0.771%", () => {
    expect(CONTAINER_NOTFOUND_STREAK).toBe(12);
    expect((2 / 3) ** CONTAINER_NOTFOUND_STREAK).toBeCloseTo(4096 / 531441, 12);
    expect(classifyVideoFinish404({ consecutiveNotFound: 11, submittedAt: T0, now: PAST_GRACE })).toBe("pending");
    expect(classifyVideoFinish404({ consecutiveNotFound: 12, submittedAt: T0, now: PAST_GRACE })).toBe("fail");
    expect(classifyVideoFinish404({ consecutiveNotFound: 13, submittedAt: T0, now: PAST_GRACE })).toBe("fail");
  });

  it("90-min submittedAt backstop (core PHASE_HARD_DEADLINE) terminals a persist-less streak", () => {
    expect(CONTAINER_NOTFOUND_DEADLINE_MS).toBe(90 * 60 * 1000);
    expect(classifyVideoFinish404({ consecutiveNotFound: 1, submittedAt: T0, now: PAST_DEADLINE })).toBe("fail");
    expect(classifyVideoFinish404({
      consecutiveNotFound: 1,
      submittedAt: T0,
      now: T0 + CONTAINER_NOTFOUND_DEADLINE_MS - 1,
    })).toBe("pending");
  });

  it("a missing submittedAt does not grant the deadline and does not fail at streak 1", () => {
    expect(classifyVideoFinish404({ consecutiveNotFound: 1, submittedAt: null, now: PAST_DEADLINE })).toBe("pending");
    expect(classifyVideoFinish404({ consecutiveNotFound: 12, submittedAt: null, now: T0 })).toBe("fail");
  });

  it("nextNotFoundStreak increments from 0 / absent / garbage", () => {
    expect(nextNotFoundStreak(0)).toBe(1);
    expect(nextNotFoundStreak(undefined)).toBe(1);
    expect(nextNotFoundStreak(null)).toBe(1);
    expect(nextNotFoundStreak(4)).toBe(5);
    expect(nextNotFoundStreak(-2)).toBe(1);
    expect(nextNotFoundStreak(Number.NaN)).toBe(1);
  });

  it("parseNotFoundStreak treats absent / non-positive as 0 so a legacy token starts clean", () => {
    expect(parseNotFoundStreak(undefined)).toBe(0);
    expect(parseNotFoundStreak(0)).toBe(0);
    expect(parseNotFoundStreak(-1)).toBe(0);
    expect(parseNotFoundStreak(2.9)).toBe(2);
  });
});

// --- 3-replica VIP ----------------------------------------------------------
// Replica 0 holds the job. Replicas 1 and 2 return 404. New TCP round-robins,
// matching the measured found=4 / 404=8 (1/3) on a 3-replica VIP.

type ReplicaAnswer = { status: number; body: unknown };

function threeReplicaVip(opts: {
  jobId: string;
  holder?: 0 | 1 | 2;
  holderAnswer: () => ReplicaAnswer;
}): { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>; hits: number[] } {
  const holder = opts.holder ?? 0;
  const hits: number[] = [];
  let rr = 0;
  const j = (b: unknown, status: number) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return {
    hits,
    async fetch(input: RequestInfo) {
      const url = typeof input === "string" ? input : input.url;
      const path = new URL(url).pathname;
      const replica = rr++ % 3;
      hits.push(replica);
      if (path.startsWith("/async/status/")) {
        if (replica !== holder) return j({ error: "not found" }, 404);
        const a = opts.holderAnswer();
        return j(a.body, a.status);
      }
      if (path.startsWith("/async/")) {
        return j({ ok: true, jobId: opts.jobId, status: "pending" }, 202);
      }
      return j({ ok: true, key: "renders/film-x/out.mp4" }, 200);
    },
  };
}

/** Drive a classify function across a 3-replica VIP of status polls. */
function pollVip(
  classify: (input: VideoFinish404Input) => VideoFinish404Verdict,
  sequence: Array<"peer404" | "holder-pending" | "holder-done">,
  submittedAt: number,
  now: number,
): { verdicts: VideoFinish404Verdict[]; lastStreak: number } {
  const verdicts: VideoFinish404Verdict[] = [];
  let streak = 0;
  for (const step of sequence) {
    if (step === "peer404") {
      streak = nextNotFoundStreak(streak);
      verdicts.push(classify({ consecutiveNotFound: streak, submittedAt, now }));
    } else {
      streak = 0;
      verdicts.push("pending");
      if (step === "holder-done") break;
    }
  }
  return { verdicts, lastStreak: streak };
}

describe("3-replica VIP fixture (1 holder, 2 peers)", () => {
  it("the old rule fails on the first peer 404 past 30s -- the failure this fixture exists to produce", () => {
    const now = PAST_GRACE;
    const { verdicts } = pollVip(
      (i) => legacyClassifyVideoFinish404(i.submittedAt, i.now),
      ["peer404", "peer404", "holder-done"],
      T0,
      now,
    );
    expect(verdicts[0]).toBe("fail");
  });

  it("the new rule stays pending through the 2/3 peer 404s and reaches the holder", () => {
    const now = PAST_GRACE;
    const { verdicts, lastStreak } = pollVip(
      classifyVideoFinish404,
      ["peer404", "peer404", "holder-done"],
      T0,
      now,
    );
    expect(verdicts[0]).toBe("pending");
    expect(verdicts[1]).toBe("pending");
    expect(verdicts[2]).toBe("pending");
    expect(lastStreak).toBe(0);
  });

  it("round-robin hits are 2/3 404 on a live job (the measured 4/12 = 1/3 found)", async () => {
    const vip = threeReplicaVip({
      jobId: "job-live",
      holderAnswer: () => ({ status: 200, body: { status: "pending" } }),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await vip.fetch("http://video-finish/async/status/job-live");
      statuses.push(r.status);
    }
    const found = statuses.filter((s) => s === 200).length;
    const miss = statuses.filter((s) => s === 404).length;
    expect(found).toBe(4);
    expect(miss).toBe(8);
    expect(vip.hits).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });
});

// --- module workers against the 3-replica VIP --------------------------------

type ModuleWorker = { fetch(request: Request, env: unknown): Promise<Response> };

const subtitleInput = (): SubtitleInput => ({
  film_key: "renders/film-x/film.mp4",
  video_url: "https://r2/get",
  output_url: "https://r2/put",
  output_key: "renders/film-x/film_subbed.mp4",
  width: 1920,
  height: 1080,
  fps: 24,
  captions: [{ start: 0, end: 1, text: "hi" }],
});

const titlesInput = (): TitlesInput => ({
  film_key: "renders/film-x/film.mp4",
  video_url: "https://r2/get",
  output_url: "https://r2/put",
  output_key: "renders/film-x/film_titled.mp4",
  width: 1920,
  height: 1080,
  fps: 24,
  title: { text: "NEON" },
});

function pollReq(token: string): Request {
  return new Request("https://module/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ poll: token }),
  });
}

function invokeReq(input: unknown): Request {
  return new Request("https://module/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook: "film.finish", input, config: {}, context: {} }),
  });
}

async function drivePolls(
  worker: ModuleWorker,
  env: unknown,
  startToken: string,
  n: number,
): Promise<Array<{ ok: boolean; pending?: boolean; poll?: string; error?: string; output?: unknown }>> {
  const out: Array<{ ok: boolean; pending?: boolean; poll?: string; error?: string; output?: unknown }> = [];
  let token = startToken;
  for (let i = 0; i < n; i++) {
    const json = (await (await worker.fetch(pollReq(token), env)).json()) as typeof out[number];
    out.push(json);
    if (json.ok && json.pending && typeof json.poll === "string") token = json.poll;
    if (json.ok && !json.pending) break;
    if (!json.ok) break;
  }
  return out;
}

describe("subtitle + film-titles workers against a 3-replica VIP", () => {
  it("subtitle: a single peer 404 past 30s stays pending and carries the streak", async () => {
    const vip = threeReplicaVip({
      jobId: "job-sub",
      holder: 0,
      holderAnswer: () => ({ status: 200, body: { status: "pending" } }),
    });
    const env = { VIDEO_FINISH_VPC: vip };
    // Skip replica 0 (the holder) so the first status GET is a peer 404.
    await vip.fetch("http://video-finish/async/status/warmup");
    const token = encodeSubtitlePoll({
      jobId: "job-sub",
      filmKey: "renders/film-x/film.mp4",
      outputKey: "renders/film-x/film_subbed.mp4",
      submittedAt: Date.now() - 60_000,
      notFoundStreak: 0,
    });
    const json = (await (await subtitleWorker.fetch(pollReq(token), env)).json()) as {
      ok: boolean; pending?: boolean; poll?: string; error?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.pending).toBe(true);
    expect(json.error).toBeUndefined();
    expect(typeof json.poll).toBe("string");
    expect(decodeSubtitlePoll(json.poll!)?.notFoundStreak).toBe(1);
  });

  it("film-titles: a single peer 404 past 30s stays pending (same rule, same comment)", async () => {
    const vip = threeReplicaVip({
      jobId: "job-abc",
      holder: 0,
      holderAnswer: () => ({ status: 200, body: { status: "pending" } }),
    });
    const env = { VIDEO_FINISH_VPC: vip };
    await vip.fetch("http://video-finish/async/status/warmup");
    const token = encodeTitlesPoll({
      jobId: "job-abc",
      filmKey: "renders/film-x/film.mp4",
      outputKey: "renders/film-x/film_titled.mp4",
      submittedAt: Date.now() - 60_000,
      notFoundStreak: 0,
      titleSeconds: 3,
    });
    const json = (await (await titlesWorker.fetch(pollReq(token), env)).json()) as {
      ok: boolean; pending?: boolean; error?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.pending).toBe(true);
    expect(json.error).toBeUndefined();
  });

  it("subtitle: peer 404s then the holder completes (the path a single-stub suite cannot observe)", async () => {
    let holderDone = false;
    const vip = threeReplicaVip({
      jobId: "job-sub",
      holder: 0,
      holderAnswer: () => holderDone
        ? { status: 200, body: { status: "completed", result: { ok: true, key: "renders/film-x/film_subbed.mp4", burned: true, sidecar: false } } }
        : { status: 200, body: { status: "pending" } },
    });
    const env = { VIDEO_FINISH_VPC: vip };
    const sub = (await (await subtitleWorker.fetch(invokeReq(subtitleInput()), env)).json()) as { poll: string };
    // invoke consumed RR slot 0 (submit). Next three status polls: replica 1 404, 2 404, 0 holder.
    const first = await drivePolls(subtitleWorker, env, sub.poll, 2);
    expect(first.every((p) => p.ok && p.pending)).toBe(true);
    holderDone = true;
    const last = await drivePolls(subtitleWorker, env, first[first.length - 1].poll ?? sub.poll, 2);
    const done = last.find((p) => p.ok && !p.pending);
    expect(done?.output).toMatchObject({ film_key: "renders/film-x/film_subbed.mp4" });
  });

  it("film-titles: same 3-replica complete path", async () => {
    let holderDone = false;
    const vip = threeReplicaVip({
      jobId: "job-abc",
      holder: 0,
      holderAnswer: () => holderDone
        ? { status: 200, body: { status: "completed", result: { ok: true, key: "renders/film-x/film_titled.mp4" } } }
        : { status: 200, body: { status: "pending" } },
    });
    const env = { VIDEO_FINISH_VPC: vip };
    const sub = (await (await titlesWorker.fetch(invokeReq(titlesInput()), env)).json()) as { poll: string };
    const first = await drivePolls(titlesWorker, env, sub.poll, 2);
    expect(first.every((p) => p.ok && p.pending)).toBe(true);
    holderDone = true;
    const last = await drivePolls(titlesWorker, env, first[first.length - 1].poll ?? sub.poll, 2);
    const done = last.find((p) => p.ok && !p.pending);
    expect(done?.output).toMatchObject({ film_key: "renders/film-x/film_titled.mp4" });
  });

  it("PRODUCTION SHAPE: core drops poll between calls, so the streak stays 1 and only the deadline terminals", async () => {
    // Mackaye F1: today's core PollResponse pending arm is { ok, pending, wait? } with no
    // poll field. drivePolls() above is the configuration that does not ship -- it
    // round-trips json.poll. This test drops poll the way core does. Every 404
    // decodes the ORIGINAL token (streak 0), nextNotFoundStreak is always 1, N=12
    // is unreachable. Only submittedAt past CONTAINER_NOTFOUND_DEADLINE_MS fails.
    const all404 = {
      async fetch(input: RequestInfo) {
        const url = typeof input === "string" ? input : input.url;
        const path = new URL(url).pathname;
        const j = (b: unknown, status: number) =>
          new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (path.startsWith("/async/status/")) return j({ error: "not found" }, 404);
        return j({ ok: false }, 500);
      },
    };
    const env = { VIDEO_FINISH_VPC: all404 };
    const liveToken = encodeSubtitlePoll({
      jobId: "job-prod",
      filmKey: "renders/film-x/film.mp4",
      outputKey: "renders/film-x/film_subbed.mp4",
      submittedAt: Date.now() - 60_000,
      notFoundStreak: 0,
    });
    const replies: Array<{ ok: boolean; pending?: boolean; poll?: string; error?: string }> = [];
    for (let i = 0; i < CONTAINER_NOTFOUND_STREAK; i++) {
      replies.push((await (await subtitleWorker.fetch(pollReq(liveToken), env)).json()) as (typeof replies)[number]);
    }
    expect(replies).toHaveLength(CONTAINER_NOTFOUND_STREAK);
    expect(replies.every((p) => p.ok && p.pending)).toBe(true);
    expect(replies.every((p) => decodeSubtitlePoll(p.poll!)?.notFoundStreak === 1)).toBe(true);

    const expiredToken = encodeSubtitlePoll({
      jobId: "job-prod",
      filmKey: "renders/film-x/film.mp4",
      outputKey: "renders/film-x/film_subbed.mp4",
      submittedAt: Date.now() - CONTAINER_NOTFOUND_DEADLINE_MS,
      notFoundStreak: 0,
    });
    const last = (await (await subtitleWorker.fetch(pollReq(expiredToken), env)).json()) as {
      ok: boolean; pending?: boolean; error?: string;
    };
    expect(last.ok).toBe(false);
    expect(last.error).toContain("no replica holds it");
  });

  it("subtitle: N=12 consecutive 404s (all peers, job gone) is terminal", async () => {
    const all404 = {
      async fetch(input: RequestInfo) {
        const url = typeof input === "string" ? input : input.url;
        const path = new URL(url).pathname;
        const j = (b: unknown, status: number) =>
          new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (path.startsWith("/async/status/")) return j({ error: "not found" }, 404);
        if (path.startsWith("/async/")) return j({ ok: true, jobId: "job-gone" }, 202);
        return j({ ok: false }, 500);
      },
    };
    const env = { VIDEO_FINISH_VPC: all404 };
    const token = encodeSubtitlePoll({
      jobId: "job-gone",
      filmKey: "renders/film-x/film.mp4",
      outputKey: "renders/film-x/film_subbed.mp4",
      submittedAt: Date.now() - 60_000,
      notFoundStreak: 0,
    });
    const polls = await drivePolls(subtitleWorker, env, token, CONTAINER_NOTFOUND_STREAK);
    expect(polls).toHaveLength(CONTAINER_NOTFOUND_STREAK);
    expect(polls.slice(0, 11).every((p) => p.ok && p.pending)).toBe(true);
    expect(polls[11].ok).toBe(false);
    expect(polls[11].error).toContain("no replica holds it");
  });

  it("legacy tokens (no notFoundStreak) decode to 0 and do not instantly fail", () => {
    const legacySub = btoa(JSON.stringify({
      jobId: "j", filmKey: "f", outputKey: "o", submittedAt: Date.now() - 60_000,
    }));
    expect(decodeSubtitlePoll(legacySub)?.notFoundStreak).toBe(0);
    const legacyTit = btoa(JSON.stringify({
      jobId: "j", filmKey: "f", outputKey: "o", submittedAt: Date.now() - 60_000, titleSeconds: 3,
    }));
    expect(decodeTitlesPoll(legacyTit)?.notFoundStreak).toBe(0);
    expect(decodeTitlesPoll(legacyTit)?.titleSeconds).toBe(3);
  });
});
