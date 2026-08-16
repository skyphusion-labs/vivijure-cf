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
// Optional env.STUDIO_GIT_SHA rides as `git_sha` when set (CI can inject GITHUB_SHA at deploy).
// Absent means the field is omitted; never invent a sha.

/** Keep in sync with package.json "version". tests/studio-release-287.test.ts pins the pair. */
export const PACKAGE_VERSION = "1.32.3";

export interface StudioReleaseIdentity {
  /** The studio release / build id. Prefer the `vX.Y.Z` tag form when STUDIO_RELEASE is set. */
  studio_release: string;
  /** Optional short or full git sha of the build that produced this worker. Omitted when unset. */
  git_sha?: string;
}

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
  const git_sha = nonEmpty(env.STUDIO_GIT_SHA);
  return git_sha ? { studio_release: release, git_sha } : { studio_release: release };
}
