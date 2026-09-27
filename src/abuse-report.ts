// Actual-knowledge report door. Not a scanner. A token holder flags a project; we MOVE the named
// keys into quarantine/ (copy, verify, then delete the original) and write a hold note.
// Artifact GET must not serve quarantine/.
//
// Ref GHSA-wmjq-7647-h45x. Three invariants this door holds, and must keep holding:
//
//   1. SCOPE. A reported key is a servable artifact belonging to the reported project. The allowlist
//      is ARTIFACT_PREFIXES, the same list the /api/artifact serve guard uses, so this door can
//      never reach an object the caller could not already GET; a key under renders/ must carry the
//      reported project's own segment. The project binding is not bookkeeping, it is what bounds
//      invariant 3: a takedown any caller may aim at any project's keys would be a denial-of-service
//      lever rather than a safety control, so 1 and 3 only make sense together.
//   2. METERED. One call performs up to MAX_KEYS full object copies, bounded in count but not in
//      bytes, so the route is metered (src/rate-limit.ts). It is metered as a SAFETY route: throttled
//      by the limiter, never denied by a broken one, because an abuse report must stay filable.
//   3. TAKEDOWN. A held key stops being served. Moving the object is what produces that; it also
//      invalidates any presigned URL already issued for it (/api/artifact-url), which a serve-time
//      deny-list could not do.
//
// The original is deleted ONLY after the quarantine copy is verified present, so a put that did not
// land cannot turn a takedown into data loss; a key whose copy failed is reported, not silently
// skipped, and its original stays exactly where it was.

import { isSafeRelKey } from "@skyphusion-labs/vivijure-core/key-safety";
import { json, isServedArtifactKey } from "./shared";
import { renderSlug } from "./render-progress";
import type { StudioEnv } from "./orchestrator-env";

function fail(msg: string, status = 400): Response {
  return json({ error: msg }, { status });
}

const QUARANTINE = "quarantine/";
// Re-exported: the definition moved to shared.ts so the serve route, this door and the copy paths
// share ONE rule. Kept exported from here because existing importers reach it at this path.
export { isQuarantineKey } from "./shared";
const RENDERS = "renders/";
const MAX_KEYS = 32;
const MAX_NOTE = 2000;

/** The reported project's own render namespace, using the SAME slug the render tree is written
 *  under (src/render-progress.ts). renderSlug is idempotent on an already-slugged name, so a
 *  reporter may pass either the project's display name or the segment it sees in a key. */
export function projectRenderPrefix(project: string): string {
  return `${RENDERS}${renderSlug(project)}/`;
}

/** Why this key may not be reported under this project, or null when it may.
 *  Exported so the refusal rules are testable without driving a request. */
export function keyRefusal(project: string, key: unknown): string | null {
  // The one served-space rule, not a local restatement of it (GHSA-5fj8-6pc2-x9p5).
  if (!isServedArtifactKey(key)) return "unsafe key";
  // Only renders/ carries a project segment. The other artifact namespaces (cast/, loras/,
  // uploads/, ...) are deploy-wide by construction, so there is no project to bind them to and
  // refusing them would make genuinely offending content unreportable.
  if (key.startsWith(RENDERS)) {
    const want = projectRenderPrefix(project);
    if (!key.startsWith(want) || key.length <= want.length) return "key outside the reported project";
  }
  return null;
}

export async function handleAbuseReport(req: Request, env: StudioEnv): Promise<Response> {
  let body: { project?: unknown; reason?: unknown; keys?: unknown };
  try {
    body = (await req.json()) as { project?: unknown; reason?: unknown; keys?: unknown };
  } catch {
    return fail("invalid JSON");
  }
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!project || project.length > 128 || project.includes("/") || project.includes("..")) {
    return fail("project is required");
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_NOTE) : "";
  const keysIn = Array.isArray(body.keys) ? body.keys : [];
  if (keysIn.length > MAX_KEYS) return fail("too many keys");
  const keys: string[] = [];
  for (const k of keysIn) {
    const refusal = keyRefusal(project, k);
    if (refusal) return fail(refusal);
    keys.push(k as string);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const holdId = crypto.randomUUID();
  const prefix = `${QUARANTINE}${stamp}/${holdId}/`;
  const copied: string[] = [];
  const removed: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    const obj = await env.R2_RENDERS.get(key);
    if (!obj) {
      missing.push(key);
      continue;
    }
    const dest = prefix + key;
    await env.R2_RENDERS.put(dest, obj.body, { httpMetadata: obj.httpMetadata });
    // head() is the identity check, never a body GET (docs/r2-verification.md): listing/head is
    // identity authority. No copy confirmed means no delete, so the original survives the failure.
    const held = await env.R2_RENDERS.head(dest);
    if (!held) {
      failed.push(key);
      continue;
    }
    copied.push(dest);
    await env.R2_RENDERS.delete(key);
    removed.push(key);
  }
  const noteKey = `${prefix}HOLD.json`;
  await env.R2_RENDERS.put(noteKey, JSON.stringify({
    hold_id: holdId,
    project,
    reason,
    keys,
    copied,
    removed,
    missing,
    failed,
    at: new Date().toISOString(),
  }), { httpMetadata: { contentType: "application/json" } });
  if (failed.length > 0) {
    // Honest partial: the note records exactly which originals are still servable, and the caller
    // is told the takedown is incomplete rather than handed an ok that did not happen.
    return json({
      error: "quarantine incomplete: some originals are still in place",
      hold_id: holdId,
      note_key: noteKey,
      copied: copied.length,
      removed: removed.length,
      failed: failed.length,
    }, { status: 503 });
  }
  return json({
    ok: true,
    hold_id: holdId,
    copied: copied.length,
    removed: removed.length,
    missing: missing.length,
    note_key: noteKey,
  });
}
