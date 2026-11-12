// Studio release / build identity projected on GET /api/modules (cf#287).
//
// WHY: the registry describes what a module CLAIMS to be (hand-maintained manifest versions) and
// carries nothing about which studio BUILD is serving those claims. Two studios on different
// releases (e.g. v1.12.0 vs v1.13.0) can project byte-identical module versions while one records
// every RunPod job and the other records none. The cf#278 harness nearly reported PARITY between
// those doors because the projection could not distinguish them.
//
// Resolution order (first non-empty wins):
//   1. env.STUDIO_RELEASE -- what the control plane already tracks per tenant; bound when an
//      operator (or the plane) stamps the live release tag onto the worker.
//   2. PACKAGE_VERSION    -- baked from package.json at source; every self-host / flagship deploy
//      of a given tag serves a different constant than the prior tag, so two releases are always
//      distinguishable even when STUDIO_RELEASE is unset.
//
// cf#1347: `git_sha` is ALWAYS present: env.STUDIO_GIT_SHA when the deploy stamps one, else null. Never a
// guess. `core_version` is the vivijure-core this worker was BUILT with, read from the installed
// package's package.json by the bundler at build time, so it cannot drift from what is running. Both are
// checked for shape before they are projected, so a mis-set variable (a token pasted into
// STUDIO_GIT_SHA, say) is reported as null and never echoed on an unauthenticated route.
import corePackage from "@skyphusion-labs/vivijure-core/package.json";

/** Keep in sync with package.json "version". tests/studio-release-287.test.ts pins the pair. */
export const PACKAGE_VERSION = "1.49.1";

export interface StudioReleaseIdentity {
  /** The studio release / build id. Prefer the `vX.Y.Z` tag form when STUDIO_RELEASE is set. */
  studio_release: string;
  /** Short or full git sha of the build that produced this worker, as the deploy stamped it. null when
   *  the deploy stamps none, or the value is not a hex sha. */
  git_sha: string | null;
  /** The vivijure-core version this worker was built with (the installed package). null if unreadable. */
  core_version: string | null;
}

const GIT_SHA = /^[0-9a-f]{7,40}$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The installed vivijure-core version, baked at build time. Exported for its test. */
export const CORE_VERSION: string | null = (() => {
  const v = (corePackage as { version?: unknown }).version;
  return typeof v === "string" && SEMVER.test(v) ? v : null;
})();

function nonEmpty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Resolve the identity this worker should advertise. Pure over its inputs for unit tests. */
export function resolveStudioRelease(env: {
  STUDIO_RELEASE?: string;
  STUDIO_GIT_SHA?: string;
}): StudioReleaseIdentity {
  const release = nonEmpty(env.STUDIO_RELEASE) ?? PACKAGE_VERSION;
  const sha = nonEmpty(env.STUDIO_GIT_SHA);
  return {
    studio_release: release,
    git_sha: sha && GIT_SHA.test(sha) ? sha : null,
    core_version: CORE_VERSION,
  };
}
