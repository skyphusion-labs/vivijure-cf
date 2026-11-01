// Bounded retry for R2 errors that are really temporary.
//
// Without this, one R2 internal error in a film tick failed the whole part: core turns any throw in a tick into a
// terminal failure, and nothing retried the call. studioEnv applies this once, so every route and the cron pass
// use it. It repeats storage calls only, so it can never buy anything.
//
// Not covered: reading a body. `(await get(key)).text()` happens after this returns. An outage longer than the
// backoff still reaches core's terminal path.

const RETRYING = Symbol.for("vivijure.r2-retrying");

/** Cloudflare R2 error reference: 10001 InternalError, 10043 ServiceUnavailable, 10058 TooManyRequests. */
const TEMPORARY = /\((?:10001|10043|10058)\)\s*$|network connection lost/i;

/** Waits between attempts, in ms. Five attempts over about 3.7 s. */
export const R2_RETRY_DELAYS_MS = [200, 500, 1000, 2000];

export function isTemporaryR2Error(e: unknown): boolean {
  return TEMPORARY.test(e instanceof Error ? e.message : String(e));
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(op: string, call: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= R2_RETRY_DELAYS_MS.length || !isTemporaryR2Error(e)) throw e;
      console.warn(JSON.stringify({ ev: "r2.retry", op, attempt: attempt + 1, error: String(e).slice(0, 200) }));
      await sleep(R2_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function replayable(body: unknown): boolean {
  return body === null || body === undefined || typeof body === "string"
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob;
}

/** A conditional put is not repeated: if the first one wrote and then errored, the repeat would read as a lost
 *  claim. A stream is not repeated because it has been read. Both fail as they did before. */
function putIsSafeToRepeat(args: unknown[]): boolean {
  const options = args[2] as { onlyIf?: unknown } | undefined;
  return replayable(args[1]) && options?.onlyIf === undefined;
}

/** Wraps a bucket once. A second wrap, also through another proxy that passes properties on, returns its input. */
export function retryingBucket<B extends object>(bucket: B, sleep: Sleep = realSleep): B {
  if ((bucket as { [RETRYING]?: boolean })[RETRYING]) return bucket;
  return new Proxy(bucket, {
    get(target, prop) {
      if (prop === RETRYING) return true;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => Promise<unknown>;
      if (prop === "get" || prop === "head" || prop === "list" || prop === "delete") {
        return (...args: unknown[]) => withRetry(prop, () => method.apply(target, args), sleep);
      }
      if (prop === "put") {
        return (...args: unknown[]) => putIsSafeToRepeat(args)
          ? withRetry("put", () => method.apply(target, args), sleep)
          : method.apply(target, args);
      }
      return method.bind(target);
    },
  });
}
