// Align a caller `project` with the bundle it names, before the GPU backend's tenancy check.
//
// Backend `check_bundle_key_for_project` is correct: a job may only read
//   bundles/<slug>/...
//   bundles/<slug>.tar.gz
//   bundles/<slug>-<16hex>.tar.gz
// The panel bug is sending a UI / loadtest slug that does not match the key (e.g. project=
// loadtest_gpu_keyframe + bundles/neon_courier-<hash>.tar.gz). That wastes a RunPod start and
// fails as a worker ValueError. Derive the slug from the key when the caller mismatches.

const BUNDLES = "bundles/";
const HASHED = /^(.+)-([0-9a-f]{16})\.tar\.gz$/;
const FLAT = /^([^/]+)\.tar\.gz$/;

/** Same slug rule as vivijure-backend harness keys._slug. */
export function projectSlug(project: string): string {
  return project.trim().split(/\s+/).join("_").replace(/\//g, "_") || "untitled";
}

/** True when this bundle_key belongs to `project` under the backend's three accepted layouts. */
export function bundleKeyMatchesProject(bundleKey: string, project: string): boolean {
  if (typeof bundleKey !== "string" || !bundleKey.startsWith(BUNDLES)) return false;
  const slug = projectSlug(project);
  const rest = bundleKey.slice(BUNDLES.length);
  if (rest.startsWith(slug + "/")) return true;
  if (rest === slug + ".tar.gz") return true;
  return new RegExp("^" + escapeRe(slug) + "-[0-9a-f]{16}\\.tar\\.gz$").test(rest);
}

/** Project slug encoded in a studio bundle key, or null when the shape is not one we emit. */
export function projectSlugFromBundleKey(bundleKey: string): string | null {
  if (typeof bundleKey !== "string" || !bundleKey.startsWith(BUNDLES)) return null;
  const rest = bundleKey.slice(BUNDLES.length);
  const hashed = HASHED.exec(rest);
  if (hashed) return hashed[1];
  const flat = FLAT.exec(rest);
  if (flat) return flat[1];
  const slash = rest.indexOf("/");
  if (slash > 0) return rest.slice(0, slash);
  return null;
}

/**
 * Project the GPU backend will accept for this bundle.
 * A matching caller project is kept (trimmed). A mismatch or omitted project becomes the slug
 * from the key so we never send a tenancy-violating pair to RunPod.
 */
export function resolveProjectForBundle(bundleKey: string, callerProject?: string | null): string {
  const caller = typeof callerProject === "string" ? callerProject.trim() : "";
  if (caller && bundleKeyMatchesProject(bundleKey, caller)) return caller;
  return projectSlugFromBundleKey(bundleKey) ?? (caller || bundleKey);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
