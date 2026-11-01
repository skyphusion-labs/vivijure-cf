// Bounded retry for R2 errors that are really temporary.
//
// Without this, one R2 internal error in a film tick failed the whole part: core turns any throw in a tick into a
// terminal failure, and nothing retried the call. studioEnv applies this for the studio. Each module applies it at
// its own entries, since a module binds its own R2_RENDERS. It repeats storage calls only.
//
// Not covered: reading a body, since `(await get(key)).text()` happens after this returns; a conditional put; a
// stream put. An outage longer than the backoff still fails what it fails today.
//
// Known risk: a repeated plain put can overwrite a newer write, when the first try landed and errored and another
// writer got in between. Rare, and worse only for a doc two writers share.

const RETRYING = Symbol.for("vivijure.r2-retrying");

/** Cloudflare R2 error reference: 10001 InternalError, 10043 ServiceUnavailable, 10054 ClientDisconnect,
 *  10058 TooManyRequests. */
const TEMPORARY = /\((?:10001|10043|10054|10058)\)\s*$|network connection lost/i;

/** Waits between attempts, in ms, each with up to 25% jitter added. Five attempts over 3.7 to 4.6 s. */
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
      await sleep(R2_RETRY_DELAYS_MS[attempt] * (1 + Math.random() * 0.25));
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

/** For a module entry. Changes the env in place, as studioEnv does, and is safe to call on every request. */
export function withRetryingR2<E extends { R2_RENDERS?: object }>(env: E): E {
  if (env.R2_RENDERS) env.R2_RENDERS = retryingBucket(env.R2_RENDERS);
  return env;
}
