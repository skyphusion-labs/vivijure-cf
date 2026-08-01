// Put the tenant's per-job R2 credential into a RunPod /run body (cp#270).
//
// ONE PLACE, TWO MODULES. `keyframe` and `own-gpu` both submit to the vivijure-backend endpoint,
// which may be POOLED across tenants, so both must carry the block. The rule that governs it is
// small and unforgiving, so it lives here rather than being spelled out twice:
//
//   THE BACKEND REFUSES AN EXPLICIT `"r2": null` rather than reading it as absent.
//
// `R2Config.from_payload_or_env` treats an ABSENT block as "use the endpoint environment" (which is
// how every dedicated endpoint works today) and a PRESENT-but-malformed block as a hard job failure,
// because a silent fallback would run a tenant's job against the wrong bucket under the wrong
// credential. A null is malformed. So a producer that helpfully sets `r2: null` when it has nothing
// fails EVERY job on a dedicated endpoint, which is the entire installed base.
//
// This helper therefore returns the body UNCHANGED when there is nothing to attach. It does not set
// the key to undefined and rely on JSON.stringify dropping it: that works today by a property of the
// serialiser rather than by intent, and it would break silently under any serialiser that emits
// nulls. The absence is structural.

// The shape is VENDORED per module (each modules/<name>/src/contract.ts carries it), so this
// shared helper declares the minimal structural form it needs rather than importing one
// module contract into another. Structural typing means a vendored TenantR2Config satisfies it.
export interface TenantR2Config {
  endpoint: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string;
}

/** The shape both module body builders already return. */
export interface RunpodBody {
  input: Record<string, unknown>;
}

/**
 * Attach the block INSIDE the RunPod `input` object, alongside `action` / `project` / `bundle_key`,
 * which is where `vivijure-backend/docs/contract.md` specifies it.
 *
 * Non-mutating: the caller's body is left alone and a new object is returned. That is the opposite
 * of `takeTenantR2`'s deliberate mutation, and for the opposite reason -- here nothing downstream
 * holds a reference we need to sanitise, and a builder that mutated its argument would be a surprise
 * to a caller that reuses it.
 */
export function withTenantR2Body<B extends RunpodBody>(body: B, r2: TenantR2Config | null): B {
  if (!r2) return body;
  return { ...body, input: { ...body.input, r2 } };
}
