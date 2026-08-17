import { afterEach } from "vitest";

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

/** Honest /async/finish + /async/status. Same protocol as core 1.21.2. */
export function vfAsyncFinish(
  result: unknown,
  opts: { jobId?: string; fail?: "submit" | "job"; error?: string } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const jobId = opts.jobId ?? "job-test";
  const json = (b: unknown, status: number) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (input) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("/async/finish")) {
      if (opts.fail === "submit") {
        return json({ ok: false, error: opts.error || "submit failed" }, 500);
      }
      return json({ ok: true, jobId, status: "pending" }, 202);
    }
    if (u.includes("/async/status/")) {
      if (opts.fail === "job") {
        return json({ ok: true, status: "failed", error: opts.error || "video-finish job failed" }, 200);
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
