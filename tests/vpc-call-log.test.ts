// cf#396: wall-clock attribution for fleet Traefik HTTPS door hops from the four finishing modules.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  vpcElapsedAppliedTag,
  withVpcElapsedApplied,
  logVpcCall,
  timedVpcFetch,
  logVpcAsyncTerminal,
  VPC_ELAPSED_APPLIED_PREFIX,
} from "../modules/_shared/vpc-call-log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vpcElapsedAppliedTag / withVpcElapsedApplied", () => {
  it("formats a non-negative integer ms tag", () => {
    expect(vpcElapsedAppliedTag(1234.6)).toBe("vpc:elapsed_ms=1235");
    expect(vpcElapsedAppliedTag(-5)).toBe("vpc:elapsed_ms=0");
  });

  // cf#396: ABSENT BECOMES NULL, NEVER 0. A 0 would read as a real measurement of a call that
  // took no time and under-count every total built from these tags. This is the same rule the
  // RunPod job log states in modules/_shared/runpod-job-log.ts.
  it("returns null for a duration it could not measure, and never a zero", () => {
    expect(vpcElapsedAppliedTag(Number.NaN)).toBeNull();
    expect(vpcElapsedAppliedTag(Number.POSITIVE_INFINITY)).toBeNull();
    expect(vpcElapsedAppliedTag(null)).toBeNull();
    expect(vpcElapsedAppliedTag(undefined)).toBeNull();
  });

  // The other half of the rule, and the one that catches an over-correction: a duration that was
  // REPORTED as zero is a real observation and is kept. A fix that collapsed every 0 to null
  // would satisfy the test above and fail this one.
  it("keeps a REPORTED zero as zero", () => {
    expect(vpcElapsedAppliedTag(0)).toBe("vpc:elapsed_ms=0");
    expect(withVpcElapsedApplied(["film-titles"], 0)).toEqual(["film-titles", "vpc:elapsed_ms=0"]);
  });

  it("adds NO tag at all when the duration is not measurable", () => {
    expect(withVpcElapsedApplied(["film-titles"], null)).toEqual(["film-titles"]);
    expect(withVpcElapsedApplied(["film-titles"], Number.NaN)).toEqual(["film-titles"]);
    // and it must not strip a tag that is already there
    expect(withVpcElapsedApplied(["film-titles", "vpc:elapsed_ms=7"], null)).toEqual([
      "film-titles",
      "vpc:elapsed_ms=7",
    ]);
  });

  it("appends once and replaces an existing tag rather than stacking", () => {
    expect(withVpcElapsedApplied(["film-titles"], 10)).toEqual(["film-titles", "vpc:elapsed_ms=10"]);
    expect(withVpcElapsedApplied(["film-titles", "vpc:elapsed_ms=1"], 99)).toEqual([
      "film-titles",
      "vpc:elapsed_ms=99",
    ]);
  });

  it("does not mutate the input array", () => {
    const applied = ["loudnorm"];
    const next = withVpcElapsedApplied(applied, 50);
    expect(applied).toEqual(["loudnorm"]);
    expect(next).toEqual(["loudnorm", "vpc:elapsed_ms=50"]);
    expect(next[1].startsWith(VPC_ELAPSED_APPLIED_PREFIX)).toBe(true);
  });
});

describe("logVpcCall", () => {
  it("emits a structured vpc.call line with start + elapsed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logVpcCall({
      module: "audio-master",
      service: "audio-master",
      binding: "AUDIO_MASTER_VPC",
      route: "/master",
      mode: "sync",
      outcome: "ok",
      startedAtMs: 1_700_000_000_000,
      elapsedMs: 42.2,
      httpStatus: 200,
      filmKey: "renders/x/bed.wav",
      project: "neon",
      contextJobId: "job-1",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      ev: "vpc.call",
      module: "audio-master",
      service: "audio-master",
      binding: "AUDIO_MASTER_VPC",
      route: "/master",
      mode: "sync",
      outcome: "ok",
      started_at_ms: 1_700_000_000_000,
      elapsed_ms: 42,
      http_status: 200,
      film_key: "renders/x/bed.wav",
      project: "neon",
      context_job_id: "job-1",
    });
  });

  it("never throws even if console.log throws", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() =>
      logVpcCall({
        module: "beat-sync",
        service: "audio-beat-sync",
        binding: "AUDIO_BEAT_SYNC_VPC",
        route: "/analyze",
        mode: "sync",
        outcome: "ok",
        startedAtMs: 1,
        elapsedMs: 1,
      }),
    ).not.toThrow();
  });
});

describe("timedVpcFetch", () => {
  it("times a successful sync hop and logs ok", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await timedVpcFetch(fetchFn, { method: "POST" }, {
      module: "beat-sync",
      service: "audio-beat-sync",
      binding: "AUDIO_BEAT_SYNC_VPC",
      url: "http://audio-beat-sync/analyze",
      mode: "sync",
      filmKey: "film-1",
    });
    expect(result.resp?.status).toBe(200);
    expect(result.err).toBeUndefined();
    expect(result.outcome).toBe("ok");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    const line = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.route).toBe("/analyze");
    expect(line.outcome).toBe("ok");
  });

  it("maps throw -> unreachable and does not rethrow", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network");
    });
    const result = await timedVpcFetch(fetchFn, undefined, {
      module: "subtitle",
      service: "video-finish",
      binding: "VIDEO_FINISH_VPC",
      url: "http://video-finish/subtitle",
      mode: "sync",
    });
    expect(result.resp).toBeUndefined();
    expect(result.outcome).toBe("unreachable");
    expect(result.err).toBeInstanceOf(TypeError);
    const line = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.outcome).toBe("unreachable");
  });

  it("maps 202 -> submitted for async_submit", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, jobId: "j1" }), { status: 202 }),
    );
    const result = await timedVpcFetch(fetchFn, { method: "POST" }, {
      module: "film-titles",
      service: "video-finish",
      binding: "VIDEO_FINISH_VPC",
      url: "http://video-finish/async/film-titles",
      mode: "async_submit",
    });
    expect(result.outcome).toBe("submitted");
    expect(result.resp?.status).toBe(202);
    const line = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.mode).toBe("async_submit");
    expect(line.outcome).toBe("submitted");
  });

  it("silent skips the log (intermediate poll RTT)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    await timedVpcFetch(fetchFn, undefined, {
      module: "film-titles",
      service: "video-finish",
      binding: "VIDEO_FINISH_VPC",
      url: "http://video-finish/async/status/j1",
      mode: "async_poll",
      silent: true,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("logVpcAsyncTerminal", () => {
  it("records job_elapsed_ms from submittedAt and returns it", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const submittedAtMs = 1_000_000;
    const nowMs = 1_000_000 + 12_345;
    const jobMs = logVpcAsyncTerminal({
      module: "film-titles",
      service: "video-finish",
      binding: "VIDEO_FINISH_VPC",
      route: "/async/status/job-abc",
      outcome: "completed",
      submittedAtMs,
      pollElapsedMs: 8,
      httpStatus: 200,
      containerJobId: "job-abc",
      nowMs,
    });
    expect(jobMs).toBe(12_345);
    const line = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      ev: "vpc.call",
      mode: "async_poll",
      outcome: "completed",
      started_at_ms: submittedAtMs,
      elapsed_ms: 8,
      job_elapsed_ms: 12_345,
      container_job_id: "job-abc",
    });
  });
});
