// plan-enhance: the first Vivijure module worker (vivijure-module/2).
//
// Serves the two contract endpoints:
//   GET  /module.json  -> the manifest (the core's registry discovers + indexes it)
//   POST /invoke       -> run the plan.enhance hook: a director pass over the storyboard's shot
//                         prompts, returning the enhanced storyboard.
//
// The director pass runs on Opus through the AI Gateway when an Opus token is configured, and
// degrades to the free Workers AI local model otherwise (or when Opus errors). A failure is DATA,
// never an exception across the wire: a bad request returns { ok:false }, and a soft miss (no model
// available, or an unparseable reply) degrades to passing the storyboard through unchanged with a
// note, so the core's chain never breaks on this stage.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PlanEnhanceInput,
  type PlanEnhanceOutput,
} from "./contract";
import {
  buildMessages,
  parseEnhanced,
  mergeEnhanced,
  parsePlanStoryboard,
  scenePrompts,
  type ChatMessage,
  type Intensity,
} from "./enhance";
import { plannerAiMockEnabled, mockPlannerRaw } from "./mock";
import {
  pickProvider,
  opusModel,
  callOpus,
  callLocal,
  LOCAL_MODEL,
  type ProviderEnv,
} from "./provider";

type Env = ProviderEnv;

// The Worker's own binding surface. GATEWAY_ID + CF_AIG_TOKEN are bound from the account-level
// Cloudflare Secrets Store (declarative config, durable across fresh-create), so the fetch handler
// resolves them to plain strings and hands the pure model layer (provider.ts) an ordinary
// ProviderEnv -- no Secrets Store type leaks into the unit-tested pure code. Both are OPTIONAL:
// with neither, pickProvider degrades to the free Workers AI local model.
interface WorkerEnv {
  AI: ProviderEnv["AI"];
  GATEWAY_ID?: SecretsStoreSecret;
  CF_AIG_TOKEN?: SecretsStoreSecret;
  ENHANCE_MODEL?: string;
  PLANNER_AI_MOCK?: string;
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset/unreadable so the existing "not configured" guards still fire. */
async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

const MANIFEST: ModuleManifest = {
  name: "plan-enhance",
  version: "0.2.1",
  api: MODULE_API,
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction", label: "Opus auto-direction" }],
  config_schema: {
    // The planning-model catalog. GET /api/storyboard/models is PROJECTED from this enum across
    // every installed plan.enhance module (src/planning-models.ts) -- the studio hardcodes no model
    // names. A third-party plan.enhance module declaring its own model enum is honored identically;
    // that is the contract, not a courtesy. Ids are catalog form ("anthropic/<slug>"); the provider
    // strips the prefix for the gateway.
    model: {
      type: "enum",
      values: [
        "anthropic/claude-opus-4-8",
        "anthropic/claude-opus-4-7",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-4-6",
      ],
      default: "anthropic/claude-opus-4-8",
      label: "model",
    },
    intensity: {
      type: "enum",
      values: ["light", "medium", "bold"],
      default: "medium",
      label: "direction intensity",
    },
  },
  ui: { section: "plan", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Run the director pass, returning the model's raw reply plus a label of the model that produced it
// (for an honest note). Opus first when configured; on any Opus error, degrade to the free local
// model. Either provider erroring throws to the caller, which degrades to passthrough.
async function direct(
  env: Env,
  messages: ChatMessage[],
  modelId?: string,
): Promise<{ reply: string | string[] | undefined; model: string }> {
  // A "@cf/..." catalog id names a Workers AI model directly; anything else rides the local default
  // when we degrade off Opus.
  const localModel = modelId?.trim().startsWith("@cf/") ? modelId.trim() : LOCAL_MODEL;
  if (pickProvider(env, modelId) === "opus") {
    try {
      return { reply: await callOpus(env, messages, modelId), model: opusModel(env, modelId) };
    } catch {
      // Opus unavailable -> fall through to the free local model rather than failing the stage.
      return {
        reply: await callLocal(env, messages, localModel),
        model: `${localModel} (opus fell back)`,
      };
    }
  }
  return { reply: await callLocal(env, messages, localModel), model: localModel };
}

/** Build the two-turn message list for the generative modes. */
function planMessages(systemMessage: string, userMessage: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (systemMessage) messages.push({ role: "system", content: systemMessage });
  messages.push({ role: "user", content: userMessage });
  return messages;
}

async function runEnhance(
  env: Env,
  req: InvokeRequest<PlanEnhanceInput>,
): Promise<InvokeResponse<PlanEnhanceOutput>> {
  const storyboard = req.input?.storyboard;
  if (!storyboard) {
    return { ok: false, error: "plan.enhance: input.storyboard required" };
  }

  // vivijure-module/2 planning modes. "enhance" (the default, and this module's original behaviour)
  // is a director pass over an existing storyboard. "plan" / "refine" / "chat" are the studio's
  // three planner entry points, routed here so model choice AND dispatch live in the module -- the
  // studio holds no model names and no provider routing (cf#62, bare-skeleton doctrine).
  const mode = typeof req.config?.mode === "string" ? req.config.mode : "enhance";
  const modelId = typeof req.config?.model === "string" ? req.config.model : undefined;
  const systemMessage =
    typeof req.config?.system_message === "string" ? req.config.system_message.trim() : "";
  const userMessage = typeof req.config?.message === "string" ? req.config.message.trim() : "";

  if (mode === "plan" || mode === "refine") {
    // Malformed I/O fails loud; only a model MISS degrades.
    if (!userMessage) {
      return { ok: false, error: `plan.enhance: config.message required for mode ${mode}` };
    }
    let reply: string | string[] | undefined;
    let modelLabel: string;
    if (plannerAiMockEnabled(env)) {
      // Dev-only (#411): replace the network dispatch with a deterministic canned completion. The
      // reply still runs the real parsePlanStoryboard -> studio validateStoryboard pipeline below.
      reply = mockPlannerRaw(userMessage);
      modelLabel = "dev-mock";
      const mocked = parsePlanStoryboard(reply);
      if (!mocked) {
        return {
          ok: true,
          output: {
            storyboard,
            notes: [`${mode} skipped: ${modelLabel} reply was not valid storyboard JSON`],
          },
        };
      }
      return { ok: true, output: { storyboard: mocked, notes: [`${mode} via ${modelLabel}`] } };
    }
    try {
      ({ reply, model: modelLabel } = await direct(
        env,
        planMessages(systemMessage, userMessage),
        modelId,
      ));
    } catch (e) {
      return {
        ok: true,
        output: { storyboard, notes: [`${mode} skipped: model error (${(e as Error).message})`] },
      };
    }
    if (reply == null) {
      return { ok: true, output: { storyboard, notes: [`${mode} skipped: no model reply`] } };
    }
    const raw = Array.isArray(reply) ? JSON.stringify(reply) : reply;
    const planned = parsePlanStoryboard(raw);
    if (!planned) {
      return {
        ok: true,
        output: {
          storyboard,
          notes: [`${mode} skipped: ${modelLabel} reply was not valid storyboard JSON`],
        },
      };
    }
    return { ok: true, output: { storyboard: planned, notes: [`${mode} via ${modelLabel}`] } };
  }

  if (mode === "chat") {
    if (!userMessage) {
      return { ok: false, error: "plan.enhance: config.message required for chat mode" };
    }
    if (plannerAiMockEnabled(env)) {
      return { ok: true, output: { storyboard: { scenes: [] }, notes: [mockPlannerRaw(userMessage)] } };
    }
    // Chat has no storyboard to pass through, so a model failure is a real failure, not a degrade.
    try {
      const { reply } = await direct(env, planMessages(systemMessage, userMessage), modelId);
      const text = Array.isArray(reply) ? reply.join("\n") : String(reply ?? "");
      if (!text.trim()) {
        return { ok: true, output: { storyboard: { scenes: [] }, notes: ["chat skipped: empty reply"] } };
      }
      return { ok: true, output: { storyboard: { scenes: [] }, notes: [text] } };
    } catch (e) {
      return { ok: false, error: "plan.enhance chat failed: " + (e as Error).message };
    }
  }

  const prompts = scenePrompts(storyboard);
  if (!prompts) {
    return { ok: false, error: "plan.enhance: input.storyboard has no scenes" };
  }
  const intensity = (req.config?.intensity as Intensity) || "medium";

  let reply: string | string[] | undefined;
  let model: string;
  try {
    ({ reply, model } = await direct(env, buildMessages(prompts, intensity), modelId));
  } catch (e) {
    // Soft degrade: no model available -> pass the storyboard through unchanged.
    return {
      ok: true,
      output: { storyboard, notes: [`enhancement skipped: model error (${(e as Error).message})`] },
    };
  }

  const enhanced = parseEnhanced(reply, prompts.length);
  if (!enhanced) {
    return {
      ok: true,
      output: { storyboard, notes: [`enhancement skipped: ${model} reply was not a clean prompt array`] },
    };
  }

  return {
    ok: true,
    output: {
      storyboard: mergeEnhanced(storyboard, enhanced),
      notes: [`enhanced ${enhanced.length} shot(s) at ${intensity} intensity via ${model}`],
    },
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") {
      return json(MANIFEST);
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<PlanEnhanceInput>;
      try {
        req = (await request.json()) as InvokeRequest<PlanEnhanceInput>;
      } catch {
        const bad: InvokeResponse = { ok: false, error: "invalid JSON body" };
        return json(bad);
      }
      if (req.hook !== "plan.enhance") {
        const bad: InvokeResponse = { ok: false, error: `unsupported hook ${String(req.hook)}` };
        return json(bad);
      }
      // Resolve the Secrets Store bindings to plain strings, then hand the pure model layer an
      // ordinary ProviderEnv. secretValue -> "" for an unset/unreadable secret, so pickProvider
      // degrades to the free local model exactly as before.
      const provEnv: ProviderEnv = {
        AI: env.AI,
        GATEWAY_ID: await secretValue(env.GATEWAY_ID),
        CF_AIG_TOKEN: await secretValue(env.CF_AIG_TOKEN),
        ENHANCE_MODEL: env.ENHANCE_MODEL,
        PLANNER_AI_MOCK: env.PLANNER_AI_MOCK,
      };
      return json(await runEnhance(provEnv, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
