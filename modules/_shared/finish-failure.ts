// How a finish module says why a step did not do its work (core#377).
//
// The core reads `failure` on a passthrough output. `transient` holds the film and retries the step,
// `permanent` names the step as not done and moves on. This file is the one place an HTTP answer or a
// transport error becomes that verdict, so the modules cannot drift into different readings.
//
// A 4xx is PERMANENT, and that includes 401: a bad token is a configuration fault that no wait cures.
// 429 and 5xx are transient. Only 429 is `capacity`, which is the one code the core will hold for
// hours. Everything else is on the short transport bound, because an origin that cannot be reached may
// be a misconfiguration that never clears. Never use this for a CSAM refusal: that is a hard failure.

export interface StepFailureShape {
  kind: "transient" | "permanent";
  code: string;
  detail?: string;
}

export const FAILURE_UNREACHABLE: StepFailureShape = { kind: "transient", code: "unreachable" };
export const FAILURE_BAD_RESPONSE: StepFailureShape = { kind: "transient", code: "bad_response" };
export const FAILURE_REFUSED: StepFailureShape = { kind: "permanent", code: "refused" };
export const FAILURE_NOT_CONFIGURED: StepFailureShape = { kind: "permanent", code: "not_configured" };

export function failureFromStatus(status: number): StepFailureShape {
  if (status === 429) return { kind: "transient", code: "capacity", detail: "HTTP 429" };
  if (status >= 500) return { kind: "transient", code: "server_error", detail: `HTTP ${status}` };
  return { kind: "permanent", code: "refused", detail: `HTTP ${status}` };
}

/** Add a verdict to a module's passthrough response. Anything that is not an output is unchanged. */
export function withFailure<T extends { ok: boolean }>(resp: T, failure: StepFailureShape): T {
  const r = resp as T & { output?: { failure?: StepFailureShape } };
  if (r.ok && r.output) r.output.failure = failure;
  return resp;
}
