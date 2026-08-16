import { describe, it, expect } from "vitest";
import { installVfFetch } from "./install-vf-fetch";
import titlesWorker from "../modules/film-titles/src/index";
import subtitleWorker from "../modules/subtitle/src/index";
import { checkHookOutput } from "@skyphusion-labs/vivijure-core/modules/conformance";

// THE CARDED FILM REPORTS ITS OWN LENGTH (skyphusion-labs/vivijure#805, cf#268).
//
// Conrad, 2026-08-02: "we bill on the last writer." The meter deducts on the final length of a
// successfully completed video, and a film that gets title cards is LONGER than its assemble output --
// so billing the assemble figure under-bills by the length of every card, on every film that gets one.
// vivijure-core stores the number in renders.output_ms and resolves it by looking up the FINAL film
// key; these two modules are the only things that can tell it the length of a CARDED film.
//
// THIS IS WIRING A VALUE THAT ALREADY EXISTS, NOT A NEW MEASUREMENT. The video-finish container has
// always returned `durationSeconds` on /film-titles (app.py:838) and /subtitle (app.py:1058); it was
// simply never carried onto the module contract. Nobody should go looking for container work here.
//
// THE TRAP THIS FILE EXISTS FOR. The container returns `durationSeconds` UNCONDITIONALLY, and on a
// subtitle run that only writes a sidecar it is the 0.0 initialiser (app.py:1019 sets it, and only the
// burn branch at :1048 ever probes). Forwarding that blindly would attach a zero to an artifact the
// step never wrote, fail the core's film.finish conformance check (which rejects <= 0 deliberately --
// a 0 in a billing column is indistinguishable from "not measured" once stored) and soft-degrade a
// sidecar-only run that succeeded. A working path would have regressed because a field was piped
// through without asking what it means when the work did not happen.

const CARDED_SECONDS = 51.5;

const titlesInput = {
  film_key: "renders/film-x/film.mp4",
  video_url: "https://r2/get",
  output_url: "https://r2/put",
  output_key: "renders/film-x/film_titled.mp4",
  width: 1920, height: 1080, fps: 24,
  // REQUIRED for the module to do anything: hasCards(input) is false without a title/credits and the
  // step noops with "noop:no-cards", never reaching the container.
  title: { text: "The End" },
};
const subtitleInput = {
  ...titlesInput,
  output_key: "renders/film-x/film_subbed.mp4",
  captions: [{ start: 0, end: 3, text: "Hello there" }],
  sidecar_url: "https://r2/put-srt",
  sidecar_key: "renders/film-x/film.srt",
};

const j = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** `syncBody` is what the container answers; `asyncSupported:false` forces the synchronous route so
 *  both output-construction sites in each module get exercised rather than only one. */
function vpcEnv(syncBody: unknown, opts: { asyncSupported?: boolean; statusResult?: unknown } = {}) {
  const asyncSupported = opts.asyncSupported ?? false;
  installVfFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path.startsWith("/async/status/")) return j(opts.statusResult ?? { status: "completed", result: syncBody });
    if (path.startsWith("/async/")) {
      return asyncSupported ? j({ ok: true, jobId: "job-1", status: "pending" }, 202) : j({ ok: false, error: "unknown async route" }, 404);
    }
    return j(syncBody);
  });
  return {
    VIDEO_FINISH_URL: "https://video-finish.test",
  } as unknown as Parameters<typeof titlesWorker.fetch>[1];
}

const invoke = (input: unknown, config: Record<string, unknown> = {}) =>
  new Request("https://module/invoke", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook: "film.finish", input, config, context: { project: "p", job_id: "j" } }),
  });

type Out = { film_key?: string; applied?: string[]; duration_seconds?: number; degraded?: string };
async function outputOf(worker: typeof titlesWorker, env: Parameters<typeof titlesWorker.fetch>[1], input: unknown, config = {}) {
  const res = await worker.fetch(invoke(input, config), env);
  const body = (await res.json()) as { ok: boolean; output?: Out; pending?: boolean; poll?: string };
  return body;
}

describe("film-titles reports the length of the film it wrote", () => {
  it("carries the container's durationSeconds onto the contract", async () => {
    const env = vpcEnv({ ok: true, key: titlesInput.output_key, durationSeconds: CARDED_SECONDS });
    const body = await outputOf(titlesWorker, env, titlesInput);
    expect(body.ok).toBe(true);
    expect(body.output?.film_key).toBe(titlesInput.output_key);
    expect(body.output?.duration_seconds).toBe(CARDED_SECONDS);
  });

  it("carries the value the CONTAINER chose, not a constant", async () => {
    const env = vpcEnv({ ok: true, key: titlesInput.output_key, durationSeconds: 88.125 });
    const body = await outputOf(titlesWorker, env, titlesInput);
    expect(body.output?.duration_seconds).toBe(88.125);
  });

  it("omits the field entirely when the container reports no length", async () => {
    // Absent means NOT MEASURED. It must not become 0, and it must not become a key with undefined.
    const env = vpcEnv({ ok: true, key: titlesInput.output_key });
    const body = await outputOf(titlesWorker, env, titlesInput);
    expect(body.output).not.toHaveProperty("duration_seconds");
  });

  it("output still satisfies the core film.finish conformance contract", async () => {
    const env = vpcEnv({ ok: true, key: titlesInput.output_key, durationSeconds: CARDED_SECONDS });
    const body = await outputOf(titlesWorker, env, titlesInput);
    const check = checkHookOutput("film.finish", body.output);
    expect(check.pass, JSON.stringify(check)).toBe(true);
    // CONTROL: the checker is capable of REJECTING, so the pass above is evidence rather than a
    // constant. Without this a broken import or a permissive checker would read as conformance.
    expect(checkHookOutput("film.finish", { applied: ["film-titles"] }).pass).toBe(false);
  });
});

describe("subtitle reports a length ONLY when it actually burned a film", () => {
  it("burned: carries the length of the burned film", async () => {
    const env = vpcEnv({ ok: true, key: subtitleInput.output_key, burned: true, sidecar: false, durationSeconds: CARDED_SECONDS });
    const body = await outputOf(subtitleWorker, env, subtitleInput);
    expect(body.output?.film_key).toBe(subtitleInput.output_key);
    expect(body.output?.duration_seconds).toBe(CARDED_SECONDS);
  });

  it("THE TRAP: a sidecar-only run reports NO length, even though the container sends 0.0", async () => {
    // This is the container's real behaviour, not a hypothetical: durationSeconds is initialised to
    // 0.0 (app.py:1019) and only probed inside the burn branch (:1048), so a sidecar-only run really
    // does put a zero on the wire. The module must drop it.
    const env = vpcEnv({ ok: true, key: "", burned: false, sidecar: true, durationSeconds: 0.0 });
    const body = await outputOf(subtitleWorker, env, subtitleInput);
    expect(body.output?.applied).toContain("subtitle:sidecar");
    // film_key stays the INPUT film: nothing was written, so there is no new artifact to measure.
    expect(body.output?.film_key).toBe(subtitleInput.film_key);
    expect(body.output).not.toHaveProperty("duration_seconds");
  });

  it("THE TRAP, second half: a sidecar-only run still passes conformance", async () => {
    // The regression this guards is not a wrong number, it is a DEGRADE: had the 0.0 been forwarded,
    // the core would reject the output and soft-degrade a step that succeeded.
    const env = vpcEnv({ ok: true, key: "", burned: false, sidecar: true, durationSeconds: 0.0 });
    const body = await outputOf(subtitleWorker, env, subtitleInput);
    const check = checkHookOutput("film.finish", body.output);
    expect(check.pass, JSON.stringify(check)).toBe(true);
    // THIS NOW PROVES REJECTION, AND IT DID NOT BEFORE. Written when the installed core was 1.6.0,
    // which had no `duration_seconds <= 0` rejection, so this assertion could only report that the
    // output was well-formed. The core 1.7.0 dep bump is the commit where it started meaning what it
    // says. Measured across that bump with the guard above deliberately broken (subtitle forwarding
    // the container field blindly): on 1.6.0 this assertion PASSED with a zero on the wire; on 1.7.0
    // it FAILS with "film.finish duration_seconds, when present, must be a positive finite number".
    // Same test, same defect, different installed core.
  });

  it("burned but the container reports no length: omits the field rather than inventing one", async () => {
    const env = vpcEnv({ ok: true, key: subtitleInput.output_key, burned: true, sidecar: false });
    const body = await outputOf(subtitleWorker, env, subtitleInput);
    expect(body.output?.film_key).toBe(subtitleInput.output_key);
    expect(body.output).not.toHaveProperty("duration_seconds");
  });
});

describe("a degraded step never reports a length", () => {
  it("container failure passes the film through with no duration", async () => {
    const env = vpcEnv({ ok: false, error: "boom" });
    const body = await outputOf(titlesWorker, env, titlesInput);
    expect(body.ok).toBe(true);                       // fail-safe: the film ships uncarded (#190)
    expect(body.output?.film_key).toBe(titlesInput.film_key); // unchanged input film
    expect(body.output).not.toHaveProperty("duration_seconds");
  });
});

describe("the ASYNC completion path reports the same field as the sync one", () => {
  it("film-titles: a completed async job carries the length", async () => {
    // Both modules construct their output in TWO places (the synchronous return and completedOutput on
    // the async poll). A change applied to only one is the obvious way this drifts, so both are driven.
    const env = vpcEnv({ ok: true, key: titlesInput.output_key, durationSeconds: CARDED_SECONDS }, {
      asyncSupported: true,
      statusResult: { status: "completed", result: { ok: true, key: titlesInput.output_key, durationSeconds: CARDED_SECONDS } },
    });
    const submitted = await outputOf(titlesWorker, env, titlesInput);
    expect(submitted.pending).toBe(true);
    const res = await titlesWorker.fetch(
      new Request("https://module/poll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll: submitted.poll }),
      }),
      env,
    );
    const polled = (await res.json()) as { ok: boolean; pending?: boolean; output?: Out };
    expect(polled.pending).toBeFalsy();
    expect(polled.output?.duration_seconds).toBe(CARDED_SECONDS);
  });
});
