// Storyboard planner scaffold (cf#62).
//
// Prompt assembly + storyboard validation live here; ALL model work is delegated to an installed
// plan.enhance module. The studio holds no model names and no provider routing -- Conrad's ruling
// (2026-07-17): "nothing should be providing model names but plan.enhance", and the bare-skeleton
// doctrine generally. Before this, each entry point picked a provider off a hardcoded catalog row
// (callAnthropic / callGemini / callXai / aiRun); a third-party plan.enhance module declaring its
// own models had nowhere to be dispatched. Now the chosen model id resolves to the module that
// declared it (src/planning-models.ts) and that module is invoked over the ordinary hook contract.
//
// The three entry points map onto three module modes:
//   planStoryboard   -> config.mode = "plan"    (brief          -> storyboard JSON)
//   refineStoryboard -> config.mode = "refine"  (storyboard + delta -> storyboard JSON)
//   chatComplete     -> config.mode = "chat"    (prompt         -> plain text)
//
// Auth and provider selection are the MODULE's business; this file never reads a provider secret.

import type { Env } from "./env";
import {
  discoverModules,
  invokeModule,
  resolveFetcher,
  validateConfig,
} from "@skyphusion-labs/vivijure-core/modules/registry";
import type {
  PlanEnhanceInput,
  PlanEnhanceOutput,
  RegisteredModule,
} from "@skyphusion-labs/vivijure-core";
import {
  validateStoryboard,
  type StoryboardValidated,
} from "@skyphusion-labs/vivijure-core/storyboard-validate";
import {
  type PlannerCharacter,
  buildPlanningSystemPrompt,
  buildPlanningUserMessage,
  buildRefinementSystemPrompt,
  buildRefinementUserMessage,
} from "@skyphusion-labs/vivijure-core/planner-prompt";
import { resolvePlanningTarget } from "./planning-models";

export type { PlannerCharacter };

/** Every planning result now comes from a module, so the legacy per-provider discriminator collapses
 *  to a single value. Kept as a field so the response shape stays stable for the panel; the module
 *  that actually answered is reported separately in `module`. */
export type PlanningProvider = "module";

export interface PlanStoryboardArgs {
  brief: string;
  // v0.165.0 (#143): optional so hPlan can safely default to [] when the client omits the field
  // (new project with no cast assigned yet).
  characters: PlannerCharacter[];
  // A model id from GET /api/storyboard/models, i.e. a value some installed plan.enhance module
  // declared in its config_schema.model enum (or that module's own name when it declares none).
  model: string;
  // Optional beat-synced timing block (beat-timing.buildBeatTimingBlock). When set, it is injected
  // into the planning user message to pin the shot count + per-shot pacing to an audio bed.
  beatBlock?: string;
}

export type PlanStoryboardResult =
  | {
      ok: true;
      storyboard: StoryboardValidated;
      raw: string;
      provider: PlanningProvider;
      model: string;
      logId: string | null;
      module: string;
    }
  | {
      ok: false;
      errors: string[];
      raw: string | null;
      provider: PlanningProvider | null;
      model: string;
      logId: string | null;
      module?: string;
    };

interface PlanningModuleArgs {
  mode: "plan" | "refine" | "chat";
  model: string;
  storyboard?: unknown;
  brief?: string;
  systemMessage: string;
  userMessage: string;
}

type PlanningModuleResult =
  | { ok: true; output: PlanEnhanceOutput; module: string; raw: string }
  | { ok: false; error: string; module?: string };

/** Resolve the chosen model id to its declaring module and invoke it over the plan.enhance hook. */
async function invokePlanningModule(
  env: Env,
  opts: PlanningModuleArgs,
): Promise<PlanningModuleResult> {
  const modEnv = env as unknown as Record<string, unknown>;
  const modules: RegisteredModule[] = await discoverModules(modEnv, { cacheTtlMs: 60_000 });

  const target = resolvePlanningTarget(modules, opts.model);
  if (!target) {
    return {
      ok: false,
      error: `no plan.enhance module serves model "${opts.model}" (install a planning module)`,
    };
  }
  const mod = modules.find((m) => m.name === target.moduleName);
  if (!mod) {
    return { ok: false, error: `plan.enhance module ${target.moduleName} not found` };
  }
  const fetcher = resolveFetcher(modEnv, mod.binding);
  if (!fetcher) {
    return {
      ok: false,
      error: `plan.enhance module ${mod.name} (${mod.binding}) is not bound`,
      module: mod.name,
    };
  }

  // validateConfig fills the module's own declared defaults (e.g. intensity); the planner then
  // pins the fields it owns for this call. config.model is the module's OWN catalog id, so a
  // third-party module receives an id it minted itself.
  const config = {
    ...validateConfig(mod.config_schema, { intensity: "medium" }),
    mode: opts.mode,
    model: target.configModel ?? target.modelId,
    system_message: opts.systemMessage,
    message: opts.userMessage,
  };

  const input: PlanEnhanceInput = {
    storyboard:
      opts.mode === "plan"
        ? { scenes: [] }
        : ((opts.storyboard as PlanEnhanceInput["storyboard"]) ?? { scenes: [] }),
    brief: opts.brief,
  };

  const r = await invokeModule<PlanEnhanceInput, PlanEnhanceOutput>(fetcher, {
    hook: "plan.enhance",
    input,
    config,
    context: { project: "planner", job_id: crypto.randomUUID() },
  });

  if (!r.ok) {
    return {
      ok: false,
      error: ("error" in r ? r.error : undefined) || "plan.enhance module returned no output",
      module: mod.name,
    };
  }
  if (!("output" in r) || !r.output) {
    return { ok: false, error: "plan.enhance module returned no output", module: mod.name };
  }

  const raw =
    opts.mode === "chat"
      ? (r.output.notes?.join("\n") ?? "")
      : JSON.stringify(r.output.storyboard ?? {});

  return { ok: true, output: r.output, module: mod.name, raw };
}

export async function planStoryboard(
  env: Env,
  args: PlanStoryboardArgs,
): Promise<PlanStoryboardResult> {
  const systemMessage = buildPlanningSystemPrompt();
  const userMessage = buildPlanningUserMessage(args.brief, args.characters, args.beatBlock);

  const r = await invokePlanningModule(env, {
    mode: "plan",
    model: args.model,
    brief: args.brief,
    systemMessage,
    userMessage,
  });

  if (!r.ok) {
    return {
      ok: false,
      errors: [r.error],
      raw: null,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module,
    };
  }

  const validation = validateStoryboard(r.output.storyboard);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: r.raw,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module,
    };
  }

  return {
    ok: true,
    storyboard: validation.value,
    raw: r.raw,
    provider: "module",
    model: args.model,
    logId: null,
    module: r.module,
  };
}

// ---------- Refinement dispatcher (v0.50.0) ----------
//
// Mirrors planStoryboard's plumbing but builds a different prompt: the system message tells the
// model to apply ONE delta and preserve everything else, and the user message ships the current
// storyboard JSON + the new instruction.

export interface RefineStoryboardArgs {
  storyboard: unknown;
  message: string;
  model: string;
}

export async function refineStoryboard(
  env: Env,
  args: RefineStoryboardArgs,
): Promise<PlanStoryboardResult> {
  const systemMessage = buildRefinementSystemPrompt();
  const userMessage = buildRefinementUserMessage(args.storyboard, args.message);

  const r = await invokePlanningModule(env, {
    mode: "refine",
    model: args.model,
    storyboard: args.storyboard,
    systemMessage,
    userMessage,
  });

  if (!r.ok) {
    return {
      ok: false,
      errors: [r.error],
      raw: null,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module,
    };
  }

  const validation = validateStoryboard(r.output.storyboard);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: r.raw,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module,
    };
  }

  return {
    ok: true,
    storyboard: validation.value,
    raw: r.raw,
    provider: "module",
    model: args.model,
    logId: null,
    module: r.module,
  };
}

// ---------- One-shot text completion (planner UI helpers) ------------------
//
// Same module dispatch as plan/refine, but returns plain text instead of parsing/validating
// storyboard JSON. Used by POST /api/chat for music-prompt suggestion and other one-liner LLM calls
// from the planner frontend.

export interface ChatCompleteArgs {
  model: string;
  user_input: string;
  system_prompt?: string;
}

export type ChatCompleteResult =
  | { ok: true; output: string; model: string; logId: string | null; module: string }
  | { ok: false; error: string; model: string };

export async function chatComplete(
  env: Env,
  args: ChatCompleteArgs,
): Promise<ChatCompleteResult> {
  const systemMessage = args.system_prompt?.trim() || "You are a helpful assistant.";

  const r = await invokePlanningModule(env, {
    mode: "chat",
    model: args.model,
    systemMessage,
    userMessage: args.user_input,
  });

  if (!r.ok) {
    return { ok: false, error: r.error, model: args.model };
  }

  const output = (r.output.notes ?? []).join("\n").trim();
  if (!output) {
    return { ok: false, error: "plan.enhance module returned empty chat output", model: args.model };
  }

  return { ok: true, output, model: args.model, logId: null, module: r.module };
}
