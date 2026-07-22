#!/usr/bin/env npx tsx
/**
 * Batch-restore RunPod workersMax after idle scale-down (cf#61).
 *
 * Requires a management-capable RunPod API key (graphql Read/Write). Invoke-scoped tenant keys
 * cannot PATCH endpoints; they get honest guidance from the pre-submit reconcile in core instead.
 *
 * Usage:
 *   RUNPOD_API_KEY=... npx tsx scripts/reconcile-runpod-endpoints.ts
 *
 * Env (endpoint id + expected workersMax pairs):
 *   RUNPOD_ENDPOINT_ID + RUNPOD_WORKERS_MAX          (render backend)
 *   VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID + VIDEO_UPSCALE_RUNPOD_WORKERS_MAX
 *   MUSETALK_RUNPOD_ENDPOINT_ID + MUSETALK_RUNPOD_WORKERS_MAX
 *   AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID + AUDIO_UPSCALE_RUNPOD_WORKERS_MAX
 */
import {
  reconcileRunpodEndpointWorkersMax,
  type EndpointReconcileResult,
} from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

type Pair = { label: string; endpointId: string; workersMax: number };

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw?.trim()) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function pairsFromEnv(): Pair[] {
  const specs: Array<{ label: string; idVar: string; maxVar: string }> = [
    { label: "render backend", idVar: "RUNPOD_ENDPOINT_ID", maxVar: "RUNPOD_WORKERS_MAX" },
    { label: "video upscale", idVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID", maxVar: "VIDEO_UPSCALE_RUNPOD_WORKERS_MAX" },
    { label: "musetalk", idVar: "MUSETALK_RUNPOD_ENDPOINT_ID", maxVar: "MUSETALK_RUNPOD_WORKERS_MAX" },
    { label: "audio upscale", idVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID", maxVar: "AUDIO_UPSCALE_RUNPOD_WORKERS_MAX" },
  ];
  const out: Pair[] = [];
  for (const s of specs) {
    const endpointId = process.env[s.idVar]?.trim();
    const workersMax = envInt(s.maxVar);
    if (endpointId && workersMax != null) {
      out.push({ label: s.label, endpointId, workersMax });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!apiKey) {
    console.error("RUNPOD_API_KEY is required");
    process.exit(1);
  }
  const pairs = pairsFromEnv();
  if (pairs.length === 0) {
    console.error("No endpoint pairs configured. Set RUNPOD_ENDPOINT_ID + RUNPOD_WORKERS_MAX at minimum.");
    process.exit(1);
  }

  let failed = 0;
  for (const p of pairs) {
    const r: EndpointReconcileResult = await reconcileRunpodEndpointWorkersMax({
      apiKey,
      endpointId: p.endpointId,
      spec: { workersMax: p.workersMax },
    });
    if (r.ok) {
      const detail =
        r.action === "restored"
          ? `restored workersMax ${r.workersMaxBefore} -> ${r.workersMaxAfter}`
          : "already at spec";
      console.log(`[ok] ${p.label} (${p.endpointId}): ${detail}`);
    } else {
      failed += 1;
      console.error(`[fail] ${p.label} (${p.endpointId}): ${r.error}`);
      if (r.guidance) console.error(`       ${r.guidance}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
