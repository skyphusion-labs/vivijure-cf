import { afterEach } from "vitest";

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
  containerWrote.clear();
});

/**
 * Keys the CONTAINER has written to R2 in the current test, and the reason this is module state.
 *
 * cf#833 (core 1.25.0) made the film key one whose presence CHANGES DURING a single advance:
 *
 *   before assemble  ABSENT  -- otherwise the self-heal short-circuit fires and the real assemble
 *                              path never runs, which several fixtures deliberately arrange
 *   after  assemble  PRESENT -- the container PUTs it straight to R2 via a presigned URL
 *
 * A static `head: async () => null` cannot be both, which is why ten bespoke stubs went red on the
 * same key at once. The answer is not to pick a side per fixture, it is to model the transition.
 * The WORKER never performs that PUT, so no Worker-side mock can see it through `put` -- the door
 * answering `completed` IS the observable moment, and that is where the key is recorded.
 *
 * Cleared in afterEach, so it cannot leak between tests.
 */
const containerWrote = new Set<string>();

/** The bytes a present film reports. Above core's 2048-byte deliverability floor deliberately:
 *  ABSENT and TRUNCATED are different refusals, and a 1-byte stub trips the second while reading
 *  like the first. */
export const CONTAINER_FILM_BYTES = 4_194_304;

/**
 * An R2 `head` that answers for what the container actually wrote, and null for everything else.
 *
 * Drop-in for `head: async () => null` in any fixture that drives a video-finish door. Keys the
 * container never produced still answer null, so the ABSENT arm of the deliverability gate stays
 * reachable -- this models the write, it does not blanket-assert presence.
 */
export function vfHead(also: readonly string[] = []) {
  return async (key: string) =>
    containerWrote.has(key) || also.includes(key) ? ({ size: CONTAINER_FILM_BYTES } as unknown) : null;
}

/**
 * Record that a WRITER other than the video-finish door produced `key` in this test.
 *
 * Call it at the moment the write really happens -- inside a module's `/invoke` mock, not where the
 * response object is constructed. A fixture's invoke response says what the module WOULD return;
 * only the mock actually being CALLED says it ran. #600's in-flight guard supplies a response and
 * asserts the module was never dispatched, and that distinction is the whole reason this is a
 * function rather than a field.
 */
export function recordContainerWrite(key: unknown): void {
  if (typeof key === "string" && key) containerWrote.add(key);
}

/** True when the container has reported writing this key in the current test. */
export function containerHasWritten(key: string): boolean {
  return containerWrote.has(key);
}

/** Honest /async/finish + /async/status. Same protocol as core 1.21.2. */
export function vfAsyncFinish(
  result: unknown,
  opts: { jobId?: string; fail?: "submit" | "job"; error?: string } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const jobId = opts.jobId ?? "job-test";
  // The key THIS submission asked the container to write. Taken from the request rather than the
  // response because that is what really determines the object: the Worker presigns an outputKey
  // and the container writes exactly that one. It also covers keys a fixture cannot know -- the mux
  // output is content-hashed by core, so `renders/film-master/film-audio-<hash>.mp4` is not
  // predictable from the test at all.
  let asked: string | undefined;
  const json = (b: unknown, status: number) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (input, init) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("/async/finish")) {
      if (opts.fail === "submit") {
        // A refused submit writes nothing, so nothing is remembered.
        return json({ ok: false, error: opts.error || "submit failed" }, 500);
      }
      try {
        // core reaches this door through mediaDoorFetch, which builds a Request and passes it as
        // `input`; `init` is undefined on that path. Reading only `init.body` finds nothing and
        // looks exactly like "this submission named no key", so both shapes are handled.
        const raw =
          typeof init?.body === "string"
            ? init.body
            : input instanceof Request
              ? await input.clone().text()
              : undefined;
        const body = raw ? (JSON.parse(raw) as { outputKey?: unknown }) : undefined;
        if (typeof body?.outputKey === "string" && body.outputKey) asked = body.outputKey;
      } catch {
        // A body we cannot read or parse tells us nothing about what will be written. Staying
        // silent is correct: guessing here would assert an artifact the flow may never produce.
      }
      return json({ ok: true, jobId, status: "pending" }, 202);
    }
    if (u.includes("/async/status/")) {
      if (opts.fail === "job") {
        // A FAILED job wrote nothing, so the key stays absent and the deliverability gate can still
        // be watched refusing. That arm must not be lost to this convenience.
        return json({ ok: true, status: "failed", error: opts.error || "video-finish job failed" }, 200);
      }
      // Completion is the moment the artifact exists in R2 (cf#833). Recorded here rather than in
      // each fixture, because the Worker never performs this PUT and cannot observe it.
      const produced = (result as { key?: unknown; outputKey?: unknown } | null | undefined);
      for (const k of [asked, produced?.key, produced?.outputKey]) {
        if (typeof k === "string" && k) containerWrote.add(k);
      }
      return json({ ok: true, status: "completed", result }, 200);
    }
    return json({ ok: false, error: "unexpected video-finish path " + u }, 404);
  };
}

export function vfAsyncDoor(
  result: unknown,
  opts?: { jobId?: string; fail?: "submit" | "job"; error?: string },
): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
  return { fetch: vfAsyncFinish(result, opts) };
}

export function installVfFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("video-finish")) return handler(input, init);
    return prev.call(globalThis, input as never, init);
  }) as typeof fetch;
  undo = () => {
    globalThis.fetch = prev;
  };
}
