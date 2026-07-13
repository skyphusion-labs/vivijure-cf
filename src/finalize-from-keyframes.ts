// Finalize / cloud-animate / hybrid-animate from a completed keyframes-only preview row.

import {
  cloudMotionModules,
  defaultGpuDoorModule,
  discoverModules,
  servingForHook,
} from "@skyphusion-labs/vivijure-core";
import { readBundleScenes } from "@skyphusion-labs/vivijure-core/bundle-storyboard";
import {
  startFilmFromKeyframes,
  type FilmScene,
  type FilmKeyframeRef,
} from "@skyphusion-labs/vivijure-core/film-orchestrator";
import {
  filmJobToPollView,
  mapRenderOverridesToModuleConfigs,
} from "@skyphusion-labs/vivijure-core/film-render-bridge";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";
import {
  insertRender,
  type NewRenderRow,
  type RenderRow,
} from "@skyphusion-labs/vivijure-core/renders-db";
import { coerceQualityTier } from "@skyphusion-labs/vivijure-core/runpod-types";
import type { RunpodJobView } from "@skyphusion-labs/vivijure-core/runpod-types";
import { normalizePerShotModels } from "@skyphusion-labs/vivijure-core/storyboard-validate";
import type { ClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";

export interface AnimateFromPreviewArgs {
  parent: RenderRow;
  deriveMode: "finalized" | "cloud-finalized";
  motionBackend?: string;
  perShotModels?: Record<string, string>;
  hybridBackends?: Record<string, { backend: "gpu" | "cloud"; model?: string }>;
  defaultBackend?: "gpu" | "cloud";
  defaultCloudModel?: string;
  audioKey?: string;
}

function resolveCloudModel(requested: string | undefined, allowed: string[]): string | undefined {
  if (requested && allowed.includes(requested)) return requested;
  return allowed[0];
}

export async function resolvePreviewScenes(env: OrchestratorEnv, parent: RenderRow): Promise<FilmScene[]> {
  const fromOutput = normalizeFilmScenesFromOutput(parent.output);
  if (fromOutput.length) return fromOutput;
  const parsed = await readBundleScenes(env, parent.bundle_key);
  return parsed.map((s) => ({ shot_id: s.shot_id, prompt: s.prompt, seconds: s.seconds }));
}

function normalizeFilmScenesFromOutput(output: unknown): FilmScene[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const scenes = (output as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return [];
  const out: FilmScene[] = [];
  for (const e of scenes) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    const seconds = typeof o.seconds === "number" && o.seconds > 0 ? o.seconds : 4;
    if (shot_id && prompt) out.push({ shot_id, prompt, seconds });
  }
  return out;
}

export function selectPreviewKeyframes(parent: RenderRow): FilmKeyframeRef[] {
  const kfs = parent.keyframes ?? [];
  const locked = parent.locked_shots;
  if (Array.isArray(locked) && locked.length > 0) {
    const allow = new Set(locked);
    return kfs.filter((k) => allow.has(k.shot_id)).map((k) => ({ shot_id: k.shot_id, keyframe_key: k.key }));
  }
  return kfs.map((k) => ({ shot_id: k.shot_id, keyframe_key: k.key }));
}

function scenesForKeyframes(allScenes: FilmScene[], keyframes: FilmKeyframeRef[]): FilmScene[] {
  const allow = new Set(keyframes.map((k) => k.shot_id));
  return allScenes.filter((s) => allow.has(s.shot_id));
}

function perShotMotionFromHybrid(
  scenes: FilmScene[],
  backends: Record<string, { backend: "gpu" | "cloud"; model?: string }>,
  defaultBackend: "gpu" | "cloud",
  defaultCloud: string | undefined,
  gpuDoor: string | undefined,
): { perShot: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  for (const sc of scenes) {
    const entry = backends[sc.shot_id];
    const wantsCloud = entry?.backend === "cloud" || (entry?.backend !== "gpu" && defaultBackend === "cloud");
    if (wantsCloud) {
      const model = entry?.backend === "cloud" ? (entry.model ?? defaultCloud) : defaultCloud;
      if (!model) return { error: `shot "${sc.shot_id}": no cloud motion.backend module is installed` };
      out[sc.shot_id] = model;
    } else {
      if (!gpuDoor) {
        return { error: `shot "${sc.shot_id}": no gpu-door motion.backend module (ui.locality "byo"/"local") is installed` };
      }
      out[sc.shot_id] = gpuDoor;
    }
  }
  return { perShot: out };
}

function perShotMotionFromCloud(
  scenes: FilmScene[],
  defaultModel: string,
  perShot?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sc of scenes) {
    out[sc.shot_id] = perShot?.[sc.shot_id] ?? defaultModel;
  }
  return out;
}

export function validatePreviewParent(parent: RenderRow): string | null {
  if (parent.mode !== "keyframes-only") return "parent render is not a keyframes-only preview";
  if (parent.status !== "COMPLETED") return "parent preview is not completed";
  if (!parent.bundle_key) return "parent render has no bundle_key";
  if (!parent.keyframes?.length) return "parent preview has no keyframes";
  return null;
}

export async function animateFromPreview(
  env: OrchestratorEnv,
  args: AnimateFromPreviewArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  const err = validatePreviewParent(args.parent);
  if (err) return { ok: false, error: err, status: 400 };

  const keyframes = selectPreviewKeyframes(args.parent);
  if (!keyframes.length) return { ok: false, error: "no keyframes selected (check locked shots)", status: 400 };

  const allScenes = await resolvePreviewScenes(env, args.parent);
  if (!allScenes.length) {
    return { ok: false, error: "could not resolve scene prompts from preview output or bundle", status: 400 };
  }
  const scenes = scenesForKeyframes(allScenes, keyframes);
  if (!scenes.length) return { ok: false, error: "no scenes match the selected keyframes", status: 400 };

  const tier = coerceQualityTier(args.parent.quality_tier) ?? "final";
  const modules = await discoverModules(env);
  const mapped = mapRenderOverridesToModuleConfigs(args.parent.render_overrides ?? undefined, tier, modules);
  const cloudAllowed = cloudMotionModules(modules).map((m) => m.name);
  const gpuDoor = defaultGpuDoorModule(modules)?.name;

  let motionBackend: string | undefined;
  let perShotMotion: Record<string, string> | undefined;

  if (args.hybridBackends !== undefined) {
    const defaultCloud = resolveCloudModel(args.defaultCloudModel, cloudAllowed);
    const hybrid = perShotMotionFromHybrid(
      scenes,
      args.hybridBackends,
      args.defaultBackend ?? "gpu",
      defaultCloud,
      gpuDoor,
    );
    if ("error" in hybrid) return { ok: false, error: hybrid.error, status: 400 };
    perShotMotion = hybrid.perShot;
    motionBackend = gpuDoor ?? defaultCloud;
  } else if (args.deriveMode === "cloud-finalized") {
    const defaultCloud = resolveCloudModel(args.motionBackend ?? args.defaultCloudModel, cloudAllowed);
    if (!defaultCloud) return { ok: false, error: "no cloud motion.backend module is installed", status: 400 };
    const normalized = args.perShotModels
      ? normalizePerShotModels(args.perShotModels, new Set(cloudAllowed))
      : { perShot: {}, errors: [] as string[] };
    if (normalized.errors.length) return { ok: false, error: normalized.errors.join("; "), status: 400 };
    motionBackend = defaultCloud;
    perShotMotion = perShotMotionFromCloud(scenes, defaultCloud, normalized.perShot);
  } else {
    motionBackend = mapped.motion_backend ?? gpuDoor;
    if (!motionBackend) {
      return { ok: false, error: 'no gpu-door motion.backend module (ui.locality "byo"/"local") is installed', status: 400 };
    }
  }

  const motionInstalled = new Set(servingForHook(modules, "motion.backend").map((m) => m.name));
  const need = new Set<string>(Object.values(perShotMotion ?? {}));
  if (motionBackend) need.add(motionBackend);
  for (const n of need) {
    if (!motionInstalled.has(n)) {
      return { ok: false, error: `motion.backend module "${n}" is not installed`, status: 400 };
    }
  }

  const job = await startFilmFromKeyframes(
    env,
    {
      project: args.parent.project,
      bundle_key: args.parent.bundle_key,
      scenes,
      keyframes,
      motion_backend: motionBackend,
      per_shot_motion: perShotMotion,
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      speech_config: mapped.speech_config,
      film_finish_config: mapped.film_finish_config,
      master_config: mapped.master_config,
      derive_mode: args.deriveMode,
      parent_render_id: args.parent.id,
      audio_key: args.audioKey,
    },
    modules,
  );

  const view = filmJobToPollView(job, null);
  const row: NewRenderRow = {
    jobId: view.jobId,
    project: args.parent.project,
    bundleKey: args.parent.bundle_key,
    qualityTier: tier,
    renderOverrides: args.parent.render_overrides ?? undefined,
    status: view.status,
    mode: args.deriveMode,
    parentId: args.parent.id,
    projectId: args.parent.project_id,
  };
  await insertRender(env, row);

  return { ok: true, view };
}

export function clipAnimateProgress(
  clipJob: ClipJob,
  gpuDoors: ReadonlySet<string>,
): {
  done: number;
  total: number;
  gpu: { done: number; total: number; status?: string };
  cloud: { done: number; total: number };
} {
  let gpuDone = 0;
  let gpuTotal = 0;
  let cloudDone = 0;
  let cloudTotal = 0;
  for (const sh of clipJob.shots) {
    const mod = sh.motion_backend ?? clipJob.motion_backend;
    if (mod == null || gpuDoors.has(mod)) {
      gpuTotal++;
      if (sh.status === "done") gpuDone++;
    } else {
      cloudTotal++;
      if (sh.status === "done") cloudDone++;
    }
  }
  const done = clipJob.shots.filter((s) => s.status === "done").length;
  const gpuStatus = gpuTotal > 0 ? (gpuDone >= gpuTotal ? "done" : "rendering") : "done";
  return {
    done,
    total: clipJob.shots.length,
    gpu: { done: gpuDone, total: gpuTotal, status: gpuStatus },
    cloud: { done: cloudDone, total: cloudTotal },
  };
}
