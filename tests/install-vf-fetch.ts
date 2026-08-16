import { afterEach } from "vitest";

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

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
