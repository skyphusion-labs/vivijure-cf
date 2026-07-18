// Chat-side R2 artifacts: image outputs from POST /api/chat with image models.
//
// These are written to env.R2_RENDERS -- the bucket GET /api/artifact SERVES (cf#140).
//
// They used to go to env.R2 (a different bucket), while the serve route only ever read R2_RENDERS
// and ARTIFACT_PREFIXES advertised the "out/" namespace anyway. So every chat image preview 404'd
// in production: the write succeeded, the object existed, and it was simply unreachable through the
// only route that serves it. Every gate was green the whole time; it took driving a real generation
// and fetching the artifact back to see it.
//
// Keep write and serve on the SAME binding. A per-namespace bucket map in the serve route is the
// shape that drifted once already.

import type { Env } from "./env";
import { extFromMime } from "./utils";

export interface OutputArtifact {
  key: string;
  mime: string;
  type: "image";
}

export async function putChatArtifact(
  env: Env,
  mime: string,
  bytes: Uint8Array,
): Promise<OutputArtifact> {
  const key = `out/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2_RENDERS.put(key, bytes, {
    httpMetadata: { contentType: mime },
  });
  return { key, mime, type: "image" };
}
