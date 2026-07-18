// The studio env var contract, in a LEAF module with zero imports (cf#85).
//
// WHY IT LIVES ALONE: this list is the single source of truth for the vars a studio reads through
// its orchestrator context, and TWO very different consumers need it:
//   1. the studio runtime (cf-platform.ts re-exports it, so nothing downstream changed), and
//   2. scripts/build-studio-release.ts, a plain node build script that stamps the list into the
//      release manifest as `required_vars`.
//
// Consumer 2 is why this is a leaf. cf-platform.ts imports the Env type, the presigner, the secret
// store, the module transport and the R2 store; a build script that only wants a list of strings has
// no business dragging the entire Worker runtime graph in behind it. Keeping the list import-free
// means the builder reads the REAL contract rather than a second copy of it, which is the whole
// point: the hosted control plane binds these onto every tenant studio, the two lists drifted once
// with no link between them, and the drift surfaced only at a tenant FIRST RENDER as an opaque 500
// (R2_S3_ENDPOINT was never bound, presign threw, and the film poll kept 500ing with the keyframe
// already rendered and sitting in R2).
//
// Add a var here and it flows to the manifest on the next release, which is what lets the control
// plane derive its bind census from the pinned artifact instead of guessing.

export const ORCHESTRATOR_VAR_KEYS = [
  "AUTH_MODE",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "ALLOW_UNAUTHENTICATED",
  "DEMO_RENDER_ENABLED",
  "DEMO_ARTIFACT_ORIGIN",
  "DEMO_ASSISTANT_MODEL",
  "DEMO_RENDER_PER_IP_DAILY",
  "DEMO_RENDER_GLOBAL_DAILY",
  "DEMO_RENDER_QUEUE_DEPTH",
  "DEMO_CHAT_PER_IP_DAILY",
  "DEMO_CHAT_GLOBAL_DAILY",
  "PLANNER_AI_MOCK",
  "SPEND_LIMIT_FAIL_CLOSED",
  "SPEND_DAILY_CEILING",
  "FILM_CLIP_DURATION_FLOOR",
  "R2_S3_ENDPOINT",
  "R2_S3_BUCKET",
] as const;
