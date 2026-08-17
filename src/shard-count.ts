// Parallelism for a film/scatter submit.
// Keep in sync with vivijure-core src/scatter.ts resolveShardCount until the
// host pins a core that exports it (1.19.0).

export const DEFAULT_SHARD_MAX = 20;

export function shardMaxFromEnv(raw: unknown): number {
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SHARD_MAX;
}

/** Scatter fans a film across our GPU workers. Cloud i2v (Seedance, Veo, Flux,
 *  Kling, Wan cloud, ...) is rate-limited per key. Only own-gpu may scatter. */
export function scatterEligibleMotion(backend: unknown): boolean {
  return backend === "own-gpu";
}

/** omitted -> min(shots, defaultMax). explicit N -> clamp [1, shots]. 2 is not a default. */
export function resolveShardCount(
  requested: unknown,
  shotCount: number,
  defaultMax: number = DEFAULT_SHARD_MAX,
): number {
  const shots = Math.max(0, Math.floor(Number(shotCount)) || 0);
  if (shots === 0) return 1;
  const cap = Math.max(1, Math.floor(Number(defaultMax)) || DEFAULT_SHARD_MAX);
  const implicit = Math.min(shots, cap);
  if (requested == null || requested === "") return implicit;
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n)) return implicit;
  return Math.max(1, Math.min(Math.floor(n), shots));
}

export function scatterViewAsFilmSummary(view: {
  jobId: string;
  status: string;
  statusRaw?: string;
  error?: string;
  output?: unknown;
}): {
  film_id: string;
  phase: string;
  error?: string;
  film_key?: string;
  shards?: { total: number };
} {
  const phase =
    view.status === "COMPLETED" ? "done"
    : view.status === "FAILED" || view.status === "CANCELLED" ? "failed"
    : String(view.statusRaw || "shards");
  const out = view.output && typeof view.output === "object" ? (view.output as Record<string, unknown>) : undefined;
  const film_key = typeof out?.output_key === "string" ? out.output_key : undefined;
  const total = typeof out?.shards === "number" ? out.shards : undefined;
  return {
    film_id: view.jobId,
    phase,
    error: view.error,
    film_key,
    ...(total != null ? { shards: { total } } : {}),
  };
}
