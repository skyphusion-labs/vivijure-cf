// A paid provider call must never run again because of what happens after it succeeds (cf#1105).
//
// Measured on cf-minimax-h3, 2026-10-30: the workflow did the model call, the parse, the download and the
// R2 write inside one step with `retries: { limit: 2 }`. The parser had a defect, so three successful
// generations billed $0.40 each and no clip was stored.
//
// So the provider call is its own step, and its result is checkpointed by the workflow. A retry of that
// step only ever follows a call that threw. The parse runs once, outside any step, because retrying a
// parse of the same bytes cannot help. The store step can retry a download or an R2 write freely, because
// it never reaches the provider.
//
// THE FAILURE TEXT AFTER A PAID SUCCESS IS FIXED, AND THAT IS LOAD-BEARING. Core reads a poll error as prose
// (`classifyTransientFailure`) and resubmits a shot whose error looks transient, for example one that says
// "timeout" or "network". A resubmit is a new workflow and a new paid call. So the store failure reports
// fixed words, and the detail goes to the log only. tests/paid-generation-1105.test.ts holds these strings
// against core's real classifier.

/** Structural, so this file needs no `cloudflare:workers` import. */
export interface PaidStepRunner {
  do<T>(name: string, config: never, fn: () => Promise<T>): Promise<T>;
}

export const NOT_STORED_ERROR = "the provider finished, but the clip was not stored, and it will not be bought again";
export const NO_VIDEO_URL_ERROR = "model completed but returned no video URL";

/** Download and R2 write can blip. This covers them, and it never reaches the provider. */
const STORE_STEP_CONFIG = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

export interface PaidGeneration<P> {
  /** The provider call, and nothing after it. A throw here means no success was returned, so it retries. */
  generate: () => Promise<unknown>;
  /** Runs once. A throw is a failed render, and the provider is not called again. */
  parse: (raw: unknown) => P;
  /** Download and write. Retries on its own step. */
  store: (parsed: P) => Promise<void>;
}

export async function runPaidGeneration<P>(
  step: unknown,
  generateConfig: unknown,
  run: PaidGeneration<P>,
): Promise<void> {
  const steps = step as PaidStepRunner;
  // Round-tripped so the step returns plain JSON, which is what a workflow can checkpoint. A value that
  // does not survive this fails the parse below, with no second provider call.
  const raw = await steps.do("generate", generateConfig as never, async () => {
    const result = await run.generate();
    return result === undefined ? null : (JSON.parse(JSON.stringify(result)) as unknown);
  });
  const parsed = run.parse(raw);
  try {
    await steps.do("store", STORE_STEP_CONFIG as never, async () => {
      await run.store(parsed);
    });
  } catch (e) {
    console.error(JSON.stringify({ ev: "clip.store_failed", detail: e instanceof Error ? e.message : String(e) }));
    throw new Error(NOT_STORED_ERROR);
  }
}

/** Parse step for the doors that need a URL. */
export function requireVideoUrl(url: string | null): string {
  if (!url) throw new Error(NO_VIDEO_URL_ERROR);
  return url;
}
