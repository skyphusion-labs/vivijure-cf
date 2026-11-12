// vivijure-cf#1389 (core#431): the frame rate a long film pins for every part when the caller sends none.
//
// The join refuses parts of different rates. Parts share one finish chain, but a polish step can soft-degrade
// on one part (no interpolation there), so without a pin that part ships at 24 fps and its siblings at 48.
// The parent works the rate out ONCE, from the shared finish chain, with core's own predictor (the same
// reading as the `interpolate:Nx` tag), stores it, and sends it to every part. Core then lets the pin win
// over the rate a part's chain produced (resolveDeliveryFps) and notes a clip above it.
import { predictDeliveryFps } from "@skyphusion-labs/vivijure-core/film-model";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";

/** The rate the shared finish chain would ship at. No finish config, or none this studio serves, is 24. */
export function parentDefaultDeliveryFps(modules: RegisteredModule[], finishConfig: unknown): number {
  const serving = servingForHook(modules, "finish");
  const chain: { binding: string; config?: Record<string, unknown>; artifacts?: RegisteredModule["finish_artifacts"] }[] = [];
  if (finishConfig && typeof finishConfig === "object" && !Array.isArray(finishConfig)) {
    for (const [name, config] of Object.entries(finishConfig as Record<string, unknown>)) {
      const m = serving.find((x) => x.name === name);
      // Not a serving finish module, `finish-order` included: adds nothing. A part refuses an unserved
      // finish module by name at its own submit (cf#593).
      if (!m) continue;
      chain.push({
        binding: m.binding,
        // vivijure-cf#879: the step's declared rate_factor. Core reads no rate off the binding name.
        artifacts: m.finish_artifacts,
        config: config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : undefined,
      });
    }
  }
  return predictDeliveryFps({}, [chain]);
}
