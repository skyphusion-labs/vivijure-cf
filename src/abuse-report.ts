// Actual-knowledge report door. Not a scanner. A token holder flags a project; we MOVE the named
// keys into quarantine/ (copy, verify, then delete the original) and write a hold note.
// Artifact GET must not serve quarantine/.
//
// Ref GHSA-wmjq-7647-h45x. Three invariants this door holds, and must keep holding:
//
//   1. SCOPE, AND THE HONEST LIMIT OF IT. A reported key is a servable artifact: the allowlist is
//      ARTIFACT_PREFIXES, the same list the /api/artifact serve guard uses, so this door can never
//      reach an object the caller could not already GET.
//
//      THIS PARAGRAPH IS SCOPED TO WHAT IS ACTUALLY ENFORCED, and it must stay that way. Do not
//      restate it as "a reported key belongs to the reported project": ownership is DERIVABLE for
//      three of the twelve prefixes and genuinely is not for the rest, so a flat claim here would
//      assert a property the code does not hold, which is exactly what gets a reviewer to sign off
//      on a path nobody checked.
//
//      Ownership is DERIVED, never assumed, and there are three outcomes (resolveKeyBinding):
//        bound    -- ownership derived and it matches the reported project.
//        foreign  -- ownership derived and it belongs to a DIFFERENT project. REFUSED.
//        unbound  -- ownership is not derivable. ACCEPTED, and recorded as unbound in the hold note.
//
//      WHY UNBOUND IS ACCEPTED RATHER THAN REFUSED, and this is not a convenience. cast/, uploads/,
//      character-refs/ and cast-gen/ are where caller-supplied imagery lands, so they are the most
//      likely home of genuinely offending content. Refusing a report we cannot attribute would make
//      that content unreportable, which trades a griefing bound for a child-safety takedown path.
//      The door stays open; what changes is that it stops CLAIMING an attribution it does not have.
//
//      What the binding does bound is invariant 3: a takedown aimed at a project's keys by a caller
//      who names a different project is a denial-of-service lever rather than a safety control, so
//      1 and 3 only make sense together. That bound still holds wherever ownership is derivable.
//
//      NOTE THE BLAST RADIUS, because it is what sizes this. The hosted plane gives every tenant its
//      OWN Worker and its OWN bucket (vivijure-control-plane provisioner: vivijure-tenant-<slug>,
//      bound as both R2_RENDERS and R2), and this studio has no per-user data separation at all --
//      the credential is used only by authorizeRoute, never to filter data. So an unbound report
//      cannot cross a tenant, and `project` is an organisational unit, not a boundary between
//      people. It is a griefing and honesty problem inside one deployment, not an authz bypass.
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

/** How a reported key was attributed to a project, or why it could not be.
 *
 *  `basis` is deliberately a closed set of MACHINE-READABLE tokens rather than a sentence. This
 *  value is written into the hold note, and the hold note is what somebody eventually has to act on
 *  under a reporting duty; prose there would have to be re-parsed by whoever is deciding. */
export type BindingBasis =
  | "renders-key-segment"      // the project slug is IN the key, by construction
  | "renders.bundle_key"       // exact-match lookup against the renders row that owns the bundle
  | "renders.output_key"       // exact-match lookup against the renders row that owns the output
  | "no-owning-row"            // the lookup ran and found nothing to attribute this key to
  | "not-derivable"            // this key space carries no project, by construction
  | "db-unavailable";          // the lookup COULD NOT RUN. Not the same as finding nothing.

export type KeyBinding =
  | { kind: "bound"; project: string; basis: BindingBasis }
  | { kind: "foreign"; project: string; basis: BindingBasis }
  | { kind: "unbound"; basis: BindingBasis };

/** Which artifact namespaces can be attributed to a project, and through which column.
 *
 *  Measured against the schema rather than assumed: `renders` carries `project` alongside
 *  `bundle_key` and `output_key`, so those two key spaces resolve by exact match. `cast_members`
 *  has NO project_id and is globally slug-unique (migrations/0001_init.sql), so everything
 *  cast-shaped is deploy-wide by construction and genuinely has no project to bind to. Nothing is
 *  resolved by scanning a JSON column: a LIKE over output_json would be a guess wearing a lookup's
 *  clothes, and a wrong attribution here refuses a legitimate report. */
const DERIVABLE_BY_COLUMN: ReadonlyArray<{
  prefix: string;
  column: "bundle_key" | "output_key";
  /** Carried alongside the column so the token written into the hold note and the column actually
   *  queried cannot drift apart. tsc caught them diverging once already. */
  basis: Extract<BindingBasis, "renders.bundle_key" | "renders.output_key">;
}> = [
  { prefix: "bundles/", column: "bundle_key", basis: "renders.bundle_key" },
  { prefix: "out/", column: "output_key", basis: "renders.output_key" },
];

/** Resolve a reported key to its owning project. Never throws: a resolver that throws would take
 *  down the report door, and the door must stay filable. */
export async function resolveKeyBinding(
  env: StudioEnv,
  reportedProject: string,
  key: string,
): Promise<KeyBinding> {
  const want = renderSlug(reportedProject);

  if (key.startsWith(RENDERS)) {
    // The slug is in the key itself, so this needs no lookup and cannot be unavailable.
    const rest = key.slice(RENDERS.length);
    const slug = rest.split("/")[0] || "";
    return slug === want
      ? { kind: "bound", project: slug, basis: "renders-key-segment" }
      : { kind: "foreign", project: slug, basis: "renders-key-segment" };
  }

  const hit = DERIVABLE_BY_COLUMN.find((d) => key.startsWith(d.prefix));
  if (!hit) return { kind: "unbound", basis: "not-derivable" };

  if (!env.DB) return { kind: "unbound", basis: "db-unavailable" };
  let owner: string | null = null;
  try {
    const row = await env.DB
      .prepare(`SELECT project FROM renders WHERE ${hit.column} = ?1 AND project IS NOT NULL LIMIT 1`)
      .bind(key)
      .first<{ project: string }>();
    owner = row?.project ?? null;
  } catch {
    // A failed lookup is NOT an absence of ownership. Saying so keeps "we looked and found nothing"
    // separate from "we could not look", which are different facts to whoever reads the hold.
    return { kind: "unbound", basis: "db-unavailable" };
  }
  if (owner === null) return { kind: "unbound", basis: "no-owning-row" };

  const ownerSlug = renderSlug(owner);
  return ownerSlug === want
    ? { kind: "bound", project: ownerSlug, basis: hit.basis }
    : { kind: "foreign", project: ownerSlug, basis: hit.basis };
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
  const bindings: { key: string; kind: KeyBinding["kind"]; basis: BindingBasis; owner: string | null }[] = [];
  for (const k of keysIn) {
    // Served-space first, unchanged: this door can never reach an object the caller could not GET.
    if (!isServedArtifactKey(k)) return fail("unsafe key");
    const binding = await resolveKeyBinding(env, project, k as string);
    // REFUSE only what we can positively attribute to SOMEBODY ELSE. An unattributable key is
    // accepted, because refusing it would make offending content in cast/ and uploads/
    // unreportable; see invariant 1.
    if (binding.kind === "foreign") return fail("key outside the reported project");
    bindings.push({
      key: k as string,
      kind: binding.kind,
      basis: binding.basis,
      owner: binding.kind === "bound" ? binding.project : null,
    });
    keys.push(k as string);
  }
  const unboundCount = bindings.filter((b) => b.kind === "unbound").length;
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
  // THE HOLD NOTE IS THE RECORD SOMEBODY ACTS ON, possibly under a reporting duty, so `project`
  // must not be allowed to read as a verified attribution when it is not one. `project` is the
  // REPORTER'S CLAIM. `bindings` says, per key, whether we could stand behind that claim.
  //
  // `attribution` is stated in a field rather than left to be inferred from counts, because
  // "every key was attributed" and "nothing could be attributed" would otherwise look identical to
  // a reader who did not think to divide two numbers.
  await env.R2_RENDERS.put(noteKey, JSON.stringify({
    hold_id: holdId,
    project,
    project_is: "the reporter's claim, not a verified attribution; see bindings[] per key",
    reason,
    keys,
    bindings,
    attribution:
      unboundCount === 0 ? "all-keys-bound"
        : unboundCount === bindings.length ? "no-keys-bound"
          : "partially-bound",
    unbound_count: unboundCount,
    bound_count: bindings.length - unboundCount,
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
    unbound_keys: unboundCount,
    hold_id: holdId,
    copied: copied.length,
    removed: removed.length,
    missing: missing.length,
    note_key: noteKey,
  });
}
