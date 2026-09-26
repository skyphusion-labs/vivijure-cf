// cf#528: read the client-supplied film-submit key (option C on cf#518).
// Present and non-blank -> it replaces the 60s natural-key backstop inside core.
// Blank / whitespace / wrong type is absence; core already treats those as no key.

export function readIdempotencyKey(
  body: { idempotency_key?: unknown; idempotencyKey?: unknown } | null | undefined,
): string | undefined {
  if (!body) return undefined;
  const raw = body.idempotency_key ?? body.idempotencyKey;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : undefined;
}
