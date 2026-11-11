// The finish modules this studio ships, as RegisteredModules, with their REAL declared finish_artifacts.
// Since vivijure-cf#879 step 3 (vivijure-core#543) the core reads a finish convention only from a
// declaration, never off a binding name, so a test whose chain names a shipped finish module passes
// this list. finish-rife, finish-upscale and finish-blender come from their manifests here.
// finish-lipsync's RunPod endpoint is gone in this repo (cf#757); its declaration is the one
// vivijure-local ships (dev/manifests/finish-lipsync.json), copied verbatim.
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import { MANIFEST as RIFE } from "../../modules/finish-rife/src/manifest";
import { MANIFEST as UPSCALE } from "../../modules/finish-upscale/src/manifest";
import { MANIFEST as BLENDER } from "../../modules/finish-blender/src/manifest";

const LIPSYNC_ARTIFACTS = {
  output_key: { kind: "append_suffix", suffix: "_ls" },
  applied: [{ tag: "lipsync:{version|v15}" }],
};

const as = (manifest: object, binding: string): RegisteredModule =>
  ({ ...manifest, binding }) as unknown as RegisteredModule;

/** Every binding name these suites use for a shipped finish module. */
export const SHIPPED_FINISH_MODULES: RegisteredModule[] = [
  as(RIFE, "MODULE_FINISH_RIFE"),
  as(RIFE, "MODULE_RIFE"),
  as(UPSCALE, "MODULE_FINISH_UPSCALE"),
  as(UPSCALE, "MODULE_UPSCALE"),
  as(BLENDER, "MODULE_FINISH_BLENDER"),
  as({ name: "finish-lipsync", version: "0.2.1", api: "vivijure-module/2", hooks: ["finish"], finish_artifacts: LIPSYNC_ARTIFACTS }, "MODULE_FINISH_LIPSYNC"),
  as({ name: "finish-lipsync", version: "0.2.1", api: "vivijure-module/2", hooks: ["finish"], finish_artifacts: LIPSYNC_ARTIFACTS }, "MODULE_LIPSYNC"),
];
