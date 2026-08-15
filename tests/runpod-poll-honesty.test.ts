// F17 + #141 poll honesty (S4): a RunPod-backed module's /poll must
//   1. surface a backend error carried INSIDE `output` while the envelope status is stuck
//      non-terminal (the F17 hung-error job), and cancel the job to stop the worker billing;
//   2. tolerate a virgin endpoint's cold start (image pull outliving the #141 grace window)
//      by consulting /health before declaring a gone job failed;
//   3. (cf#307) report a backend-neutral wait phase while pending.
// The fixture for (1) is the VERBATIM RunPod status record captured as F17 evidence
// (job e0d47f04-...-e2: handler ran 155ms, returned a structured config error inside output,
// status read IN_PROGRESS forever, worker held 344s until manual cancel).
//
// cf#538: THIS SUITE IS PARAMETERISED OVER EVERY RUNPOD-POLLING WORKER, and that is the point.
// Until this change it imported keyframe alone, while own-gpu carried the same status mapping,
// the same grace windows and its own copy of the same pure helpers with no assertion anywhere.
// The two are structurally identical, which is the argument FOR covering both rather than
// against it: a mirror can drift, the keyframe half would go red, and the own-gpu half would
// have stayed green whatever it did.
//
// PARAMETERISED, NOT COPIED. A second copy of this file would acquire its own drift, and then
// the thing under test would be which copy someone remembered to edit. Every case below runs
// once per worker off ONE body, so a case that is added, sharpened, or deleted moves for both
// at once and cannot silently cover only one.
//
// WHAT THE PARAMETERISATION DELIBERATELY DOES NOT FLATTEN: each worker names a different
// identifier in its #141 failure (keyframe names the job id, own-gpu names the shot id). That is
// a real difference in what an operator can act on, so it is a per-worker expectation rather
// than a lowest-common-denominator assertion that would pass for both while proving neither.

import { describe, it, expect, vi, afterEach } from "vitest";
import kfWorker from "../modules/keyframe/src/index";
import ogWorker from "../modules/own-gpu/src/index";
import * as kfPure from "../modules/keyframe/src/keyframe";
import * as ogPure from "../modules/own-gpu/src/i2v";

// The F17 evidence record, verbatim (ids and all). Module-neutral: it is a RunPod status
// envelope, so it is the same fixture for every worker that polls RunPod.
const F17_RECORD = {
  delayTime: 940,
  executionTime: 155,
  id: "e0d47f04-efbb-44a9-bf31-c49622e94df5-e2",
  output: {
    counts: {},
    error: {
      message: "R2 config incomplete; missing env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      stage: "config",
    },
    job_id: "e0d47f04-efbb-44a9-bf31-c49622e94df5-e2",
    last_event: {
      event: "error",
      message: "R2 config incomplete; missing env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      stage: "config",
      ts: 1782964482.248,
    },
    project: "untitled",
    started_ts: 1782964482.248,
    status: "error",
    updated_ts: 1782964482.248,
  },
  status: "IN_PROGRESS",
  workerId: "bpzisf8xlaxncu",
};

/** The pure surface every RunPod-polling module carries its own copy of. Naming it as a type is
 *  half the drift check: a copy that loses an export stops compiling here rather than quietly
 *  going uncovered. */
interface PollPure {
  encodePoll: (s: never) => string;
  classifyGoneState: (submittedAt: number | undefined, now: number, graceMs?: number) => string;
  terminalErrorInOutput: (output: unknown) => string | null;
  workersStillCold: (health: unknown) => boolean;
  runpodJobGone: (httpStatus: number, body: { status?: unknown; title?: unknown } | null) => boolean;
  RUNPOD_NOTFOUND_GRACE_MS: number;
  RUNPOD_COLD_GRACE_MS: number;
}

interface PollWorker {
  fetch: (req: Request, env: unknown, ctx?: unknown) => Promise<Response>;
}

interface WorkerCase {
  /** Module id, used as the test-name prefix so a failure names the worker without digging. */
  module: string;
  worker: PollWorker;
  pure: PollPure;
  /** Mint a poll token for this worker. Each has its own PollState shape (own-gpu carries a
   *  shot id keyframe has no equivalent of), so token minting is per-worker by necessity. */
  poll: (jobId: string, submittedAt?: number) => string;
  /** What this worker's #141 failure must NAME, so the message stays actionable per worker. */
  goneNames: (jobId: string) => string;
}

const OG_SHOT = "shot_og_07";

const CASES: WorkerCase[] = [
  {
    module: "keyframe",
    worker: kfWorker as unknown as PollWorker,
    pure: kfPure as unknown as PollPure,
    poll: (jobId, submittedAt) =>
      kfPure.encodePoll({ jobId, project: "untitled", submittedAt: submittedAt ?? Date.now() }),
    goneNames: (jobId) => jobId,
  },
  {
    module: "own-gpu",
    worker: ogWorker as unknown as PollWorker,
    pure: ogPure as unknown as PollPure,
    poll: (jobId, submittedAt) =>
      ogPure.encodePoll({ jobId, project: "untitled", shotId: OG_SHOT, submittedAt: submittedAt ?? Date.now() }),
    goneNames: () => OG_SHOT,
  },
];

// A control on the parameterisation itself. A suite that silently ran over one worker (an
// intersection that emptied, a filter that matched nothing) would look exactly like this one
// passing, so the count is asserted rather than assumed.
describe("cf#538 the suite covers every RunPod-polling worker", () => {
  it("runs over BOTH workers, and says how many", () => {
    expect(CASES.map((c) => c.module)).toEqual(["keyframe", "own-gpu"]);
    expect(CASES).toHaveLength(2);
  });

  it("the two workers are DISTINCT objects, so one entry cannot stand in for the other", () => {
    expect(CASES[0].worker).not.toBe(CASES[1].worker);
    expect(CASES[0].pure).not.toBe(CASES[1].pure);
  });
});

describe.each(CASES)("$module terminalErrorInOutput (pure)", ({ pure }) => {
  it("extracts stage + message from the F17 evidence record's output", () => {
    expect(pure.terminalErrorInOutput(F17_RECORD.output)).toBe(
      "R2 config incomplete; missing env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (stage: config)",
    );
  });
  it("accepts a plain-string error field", () => {
    expect(pure.terminalErrorInOutput({ error: "boom" })).toBe("boom");
  });
  it("flags status=error even with no error detail", () => {
    expect(pure.terminalErrorInOutput({ status: "error" })).toContain("no error detail");
  });
  it("is null for a normal progress snapshot (no false positive on healthy polls)", () => {
    expect(pure.terminalErrorInOutput({ status: "running", keyframe_done: 3, counts: { shots: 8 } })).toBeNull();
    expect(pure.terminalErrorInOutput({ keyframes: [{ shot_id: "s1", key: "k" }] })).toBeNull();
    expect(pure.terminalErrorInOutput(undefined)).toBeNull();
    expect(pure.terminalErrorInOutput(null)).toBeNull();
    expect(pure.terminalErrorInOutput("string output")).toBeNull();
    expect(pure.terminalErrorInOutput({ error: "" })).toBeNull();
  });
});

describe.each(CASES)("$module workersStillCold (pure)", ({ pure }) => {
  it("true while the only worker is still initializing (virgin image pull)", () => {
    expect(pure.workersStillCold({ workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0, unhealthy: 0 } })).toBe(true);
  });
  it("true when throttled is the only sign of life", () => {
    expect(pure.workersStillCold({ workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 1 } })).toBe(true);
  });
  it("false once any worker has come up (the F17 evidence health snapshot)", () => {
    expect(pure.workersStillCold({ jobs: { completed: 0, failed: 3 }, workers: { idle: 1, initializing: 0, ready: 1, running: 0, throttled: 0, unhealthy: 0 } })).toBe(false);
  });
  it("false for a dead endpoint (nothing up, nothing coming) so a gone job still fails", () => {
    expect(pure.workersStillCold({ workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 0, unhealthy: 0 } })).toBe(false);
  });
  it("false on malformed health payloads", () => {
    expect(pure.workersStillCold(null)).toBe(false);
    expect(pure.workersStillCold({})).toBe(false);
    expect(pure.workersStillCold({ workers: "nope" })).toBe(false);
  });
});

describe.each(CASES)("$module cold grace cap (pure)", ({ pure }) => {
  it("the cold cap is a superset of the normal grace window", () => {
    expect(pure.RUNPOD_COLD_GRACE_MS).toBeGreaterThan(pure.RUNPOD_NOTFOUND_GRACE_MS);
  });
  it("a job past normal grace but inside the cold cap classifies gone-grace under the cap", () => {
    const submitted = 1_000_000;
    const now = submitted + pure.RUNPOD_NOTFOUND_GRACE_MS + 60_000; // 1min past normal grace
    expect(pure.classifyGoneState(submitted, now)).toBe("gone-failed");
    expect(pure.classifyGoneState(submitted, now, pure.RUNPOD_COLD_GRACE_MS)).toBe("gone-grace");
  });
  it("a legacy token (no submit stamp) never gets the cold extension", () => {
    expect(pure.classifyGoneState(undefined, 5, pure.RUNPOD_COLD_GRACE_MS)).toBe("gone-failed");
  });
});

// The pure helpers are DUPLICATED per module rather than shared, so their agreement is a fact to
// assert, not one to assume. Parameterising the blocks above runs both copies through the same
// cases; this block asserts the two copies still agree on the numbers, which is the drift that
// per-copy passes cannot see.
describe("cf#538 the duplicated pure helpers have not drifted apart", () => {
  it("both copies carry the SAME grace windows", () => {
    expect(kfPure.RUNPOD_NOTFOUND_GRACE_MS).toBe(ogPure.RUNPOD_NOTFOUND_GRACE_MS);
    expect(kfPure.RUNPOD_COLD_GRACE_MS).toBe(ogPure.RUNPOD_COLD_GRACE_MS);
  });
  it("both copies classify the SAME boundary the same way", () => {
    const submitted = 1_000_000;
    for (const offset of [0, 149_999, 150_000, 899_999, 900_000]) {
      const now = submitted + offset;
      expect(ogPure.classifyGoneState(submitted, now, ogPure.RUNPOD_COLD_GRACE_MS)).toBe(
        kfPure.classifyGoneState(submitted, now, kfPure.RUNPOD_COLD_GRACE_MS),
      );
    }
  });
  it("both copies read the SAME verdict off the F17 record and off a gone envelope", () => {
    expect(ogPure.terminalErrorInOutput(F17_RECORD.output)).toBe(kfPure.terminalErrorInOutput(F17_RECORD.output));
    expect(ogPure.runpodJobGone(404, { status: 404, title: "Not Found" })).toBe(
      kfPure.runpodJobGone(404, { status: 404, title: "Not Found" }),
    );
    expect(ogPure.runpodJobGone(200, { status: "IN_QUEUE" })).toBe(kfPure.runpodJobGone(200, { status: "IN_QUEUE" }));
  });
});

describe.each(CASES)("$module /poll wiring (worker-level, stubbed fetch)", ({ worker, pure, poll, goneNames }) => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep123" };
  const pollReq = (token: string) =>
    new Request("https://module/poll", { method: "POST", body: JSON.stringify({ poll: token }) });
  const body = async (token: string) =>
    (await (await worker.fetch(pollReq(token), env)).json()) as {
      ok: boolean;
      pending?: boolean;
      wait?: string;
      error?: string;
    };

  it("F17: surfaces the structured backend error on a stuck IN_PROGRESS job and cancels it", async () => {
    const urls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: RequestInit) => {
        urls.push({ url: String(u), method: init?.method ?? "GET" });
        if (String(u).includes("/status/")) {
          return new Response(JSON.stringify(F17_RECORD), { status: 200 });
        }
        return new Response("{}", { status: 200 }); // the cancel
      }),
    );
    const b = await body(poll(F17_RECORD.id));
    expect(b.ok).toBe(false); // NEVER pending -- that was the 344s spend leak
    expect(b.error).toContain("R2 config incomplete");
    expect(b.error).toContain("stage: config");
    expect(b.error).toContain(F17_RECORD.id); // the job id the operator can act on
    const cancels = urls.filter((u) => u.url.includes("/cancel/") && u.method === "POST");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].url).toContain("/v2/ep123/cancel/" + F17_RECORD.id);
  });

  it("F17: the honest error survives a failed cancel (cancel is damage control, not a gate)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify(F17_RECORD), { status: 200 });
        throw new Error("cancel transport down");
      }),
    );
    const b = await body(poll(F17_RECORD.id));
    expect(b.ok).toBe(false);
    expect(b.error).toContain("R2 config incomplete");
  });

  it("a healthy IN_PROGRESS job with a progress snapshot stays pending (no false positive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ id: "j1", status: "IN_PROGRESS", output: { status: "running", keyframe_done: 2 } }),
          { status: 200 },
        ),
      ),
    );
    // cf#307: IN_PROGRESS maps to wait=running (additive; still pending).
    expect(await body(poll("j1"))).toEqual({ ok: true, pending: true, wait: "running" });
  });

  it("cf#307: a QUEUED job reports wait=accepted, distinct from running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "j-q", status: "IN_QUEUE" }), { status: 200 })),
    );
    expect(await body(poll("j-q"))).toEqual({ ok: true, pending: true, wait: "accepted" });
  });

  it("cf#538: RUNNING is documented RunPod vocabulary and maps to running, not to nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "j-r", status: "RUNNING" }), { status: 200 })),
    );
    expect(await body(poll("j-r"))).toEqual({ ok: true, pending: true, wait: "running" });
  });

  it("cf#538: SUBMITTED is NOT RunPod vocabulary, so it gets no wait phase from a RunPod envelope", async () => {
    // Settled empirically rather than assumed. RunPod documents seven request job states and
    // SUBMITTED is not among them; it is OUR OWN render-row status, written by vivijure-core for
    // the pre-confirmation window and bucketed in-flight by the planner history. This poll path
    // reads the raw RunPod /status envelope, so the branch that matched it could never fire.
    // Asserted rather than merely deleted, so re-adding it has to argue with a test.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "j-s", status: "SUBMITTED" }), { status: 200 })),
    );
    expect(await body(poll("j-s"))).toEqual({ ok: true, pending: true });
  });

  it("cf#307: an UNMODELLED non-terminal status stays pending and reports NO wait phase", async () => {
    // The honest branch: the module does not know what phase this is, so it says nothing rather
    // than picking the most flattering of the two it does know.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "j-x", status: "SOMETHING_ELSE" }), { status: 200 })),
    );
    expect(await body(poll("j-x"))).toEqual({ ok: true, pending: true });
  });

  it("cf#307: a transient transport failure stays pending and invents no wait phase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("transport down");
      }),
    );
    expect(await body(poll("j-t"))).toEqual({ ok: true, pending: true });
  });

  it("cold start: a 404 past normal grace stays pending while /health shows no worker ever up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        if (String(u).includes("/health")) {
          return new Response(JSON.stringify({ workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0 } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    // 1 minute past the normal grace window, well inside the cold cap
    const tok = poll("j-cold", Date.now() - pure.RUNPOD_NOTFOUND_GRACE_MS - 60_000);
    // cf#307: still cold => wait=accepted
    expect(await body(tok)).toEqual({ ok: true, pending: true, wait: "accepted" });
  });

  it("cold start: the same 404 FAILS once a worker has come up (job really is gone)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        if (String(u).includes("/health")) {
          return new Response(JSON.stringify({ workers: { idle: 1, initializing: 0, ready: 1, running: 0, throttled: 0 } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const b = await body(poll("j-gone", Date.now() - pure.RUNPOD_NOTFOUND_GRACE_MS - 60_000));
    expect(b.ok).toBe(false);
    expect(b.error).toContain(goneNames("j-gone"));
    expect(b.error).toContain("#141");
  });

  it("cold start: past the COLD cap the job fails even while /health still reads cold (no pending-forever)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        if (String(u).includes("/health")) {
          return new Response(JSON.stringify({ workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0 } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const b = await body(poll("j-dead", Date.now() - pure.RUNPOD_COLD_GRACE_MS - 1_000));
    expect(b.ok).toBe(false);
    expect(b.error).toContain("#141");
  });

  it("cold start: a broken /health reads as not-cold so the #141 verdict still fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        return new Response("oops", { status: 500 });
      }),
    );
    const b = await body(poll("j-h500", Date.now() - pure.RUNPOD_NOTFOUND_GRACE_MS - 60_000));
    expect(b.ok).toBe(false);
  });

  it("a 404 inside the NORMAL grace window stays pending without touching /health (post-submit race)", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(String(u));
        return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
      }),
    );
    // cf#307: grace-window 404 => accepted (not started / not visible yet)
    expect(await body(poll("j-fresh"))).toEqual({ ok: true, pending: true, wait: "accepted" });
    expect(urls.some((u) => u.includes("/health"))).toBe(false);
  });
});
