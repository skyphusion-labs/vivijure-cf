// Which container instance serves a request, and how a full door answers. No Workers imports, so a
// plain node test can drive it.
//
// WHY PER FILM. This door used one fixed instance name, so every film's title and subtitle encode ran
// in one container and `max_instances` could never be reached. A film runs its film.finish steps one at
// a time, so one instance per film cannot overrun itself, which is why there is no job cap in app.py.
//
// Job state lives in the instance's memory, so a status read must reach the instance that holds the job.
// The caller sends the same header on the submit and on every status read. A request with no header goes
// to the old fixed name, so an older caller, and a job submitted before this shipped, still lands where
// its job is.

export const FINISH_AFFINITY_HEADER = "x-vivijure-finish-affinity";
export const FALLBACK_INSTANCE = "subtitle";
const MAX_AFFINITY_CHARS = 256;

export function instanceName(headers: Headers): string {
  const raw = (headers.get(FINISH_AFFINITY_HEADER) ?? "").trim();
  if (!raw || raw.length > MAX_AFFINITY_CHARS) return FALLBACK_INSTANCE;
  // Prefixed so no film id can ever name the fallback instance.
  return "film:" + raw;
}

// Words the platform and @cloudflare/containers use when no instance can be given. Same list as
// src/video-finish-binding.ts. Status alone cannot tell this from a crash, since the base class reports
// it as a 500 or a 503.
const CAPACITY_TEXT = [
  /maximum number of running container instances/i,
  /no container instance available/i,
  /no container instance that can be provided/i,
];

export function isCapacityRefusalText(text: string): boolean {
  return CAPACITY_TEXT.some((re) => re.test(text));
}

export function capacityResponse(): Response {
  return Response.json(
    { ok: false, error: "capacity_exhausted", detail: "the video-finish container instance limit is reached" },
    { status: 429 },
  );
}

/** Send the request to its instance. A full door answers 429, the one answer a caller may wait on. */
export async function forwardToInstance(
  request: Request,
  send: (name: string, request: Request) => Promise<Response>,
): Promise<Response> {
  let resp: Response;
  try {
    resp = await send(instanceName(request.headers), request);
  } catch (e) {
    if (isCapacityRefusalText(e instanceof Error ? e.message : String(e))) return capacityResponse();
    throw e;
  }
  if (resp.status === 500 || resp.status === 503) {
    const text = (await resp.clone().text().catch(() => "")).slice(0, 2048);
    if (isCapacityRefusalText(text)) return capacityResponse();
  }
  return resp;
}
