// Actual-knowledge report door. Not a scanner. A token holder flags a
// project; we copy named keys into quarantine/ and write a hold note.
// Artifact GET must not serve quarantine/.

import { isSafeRelKey } from "@skyphusion-labs/vivijure-core/key-safety";
import { json } from "./shared";
import type { StudioEnv } from "./orchestrator-env";

function fail(msg: string, status = 400): Response {
  return json({ error: msg }, { status });
}

const QUARANTINE = "quarantine/";
const MAX_KEYS = 32;
const MAX_NOTE = 2000;

export function isQuarantineKey(key: string): boolean {
  return key.startsWith(QUARANTINE);
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
    if (typeof k !== "string" || !isSafeRelKey(k) || isQuarantineKey(k)) {
      return fail("unsafe key");
    }
    keys.push(k);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const holdId = crypto.randomUUID();
  const prefix = `${QUARANTINE}${stamp}/${holdId}/`;
  const copied: string[] = [];
  for (const key of keys) {
    const obj = await env.R2_RENDERS.get(key);
    if (!obj) continue;
    const dest = prefix + key;
    await env.R2_RENDERS.put(dest, obj.body, { httpMetadata: obj.httpMetadata });
    copied.push(dest);
  }
  const noteKey = `${prefix}HOLD.json`;
  await env.R2_RENDERS.put(noteKey, JSON.stringify({
    hold_id: holdId,
    project,
    reason,
    keys,
    copied,
    at: new Date().toISOString(),
  }), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, hold_id: holdId, copied: copied.length, note_key: noteKey });
}
