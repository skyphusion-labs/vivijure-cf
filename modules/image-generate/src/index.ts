// The image-generate module worker (vivijure-module/2), serving the image.generate hook.
//
//   GET  /module.json -> the manifest; the core's registry discovers it and PROJECTS its declared
//                        models into the studio catalog (GET /api/models). The studio hardcodes no
//                        model names: this manifest is where they live (cf#129, bare-skeleton).
//   POST /invoke      -> generate one image, return the BYTES.
//
// Why bytes and not an R2 key: this module deliberately holds NO bucket binding. vivijure-cf#140 was
// a production defect where chat image artifacts were written to one bucket and served from another,
// so every preview 404'd while every gate stayed green. A module that cannot write cannot recreate
// that split, and a third-party module cannot invent its own namespace. The core owns persistence.
//
// Ship a new image model by adding its id to MODELS below; the catalog picks it up with no studio
// deploy. That is the whole point of the projection.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type ImageGenerateInput,
  type ImageGenerateOutput,
} from "./contract";
import { bytesToBase64, generateImageBytes, type AiRun } from "./image-gen";

interface SecretsStoreSecret {
  get(): Promise<string>;
}

interface Env {
  AI: AiRun;
  GATEWAY_ID?: SecretsStoreSecret | string;
  /** Optional BYOK key: enables transparent-PNG output on gpt-image-1.5. Absent = opaque proxy path. */
  OPENAI_API_KEY?: SecretsStoreSecret | string;
}

// The models this module can actually dispatch. Every id here is executable by image-gen.ts; a row
// the module cannot run would be a lie in the studio picker, which is the defect class cf#129 exists
// to kill. This list moved here from the studio's hardcoded src/image-models.ts.
const MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
  "@cf/black-forest-labs/flux-1-schnell",
  "google/nano-banana-pro",
  "openai/gpt-image-1.5",
  "recraft/recraftv4",
  "@cf/leonardo/lucid-origin",
  "@cf/leonardo/phoenix-1.0",
  "@cf/lykon/dreamshaper-8-lcm",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
];

const MANIFEST: ModuleManifest = {
  name: "image-generate",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["image.generate"],
  provides: [{ id: "image-gen", label: "Image generation (FLUX 2 / Nano Banana / SDXL)" }],
  config_schema: {
    // The core's projection reads THIS field to build the catalog rows, exactly as it reads
    // plan-enhance's. Same declaration form, no special-casing of this module's name anywhere.
    model: { type: "enum", values: MODELS, default: MODELS[0], label: "image model" },
  },
  ui: { section: "chat", order: 20 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The installer seeds operator-supplied secrets with a MARKED placeholder so the module deploy
// resolves at all (an unresolvable store binding fails wrangler with 10182). For a REQUIRED secret
// that is fine -- the operator replaces it or the feature is plainly broken. For an OPTIONAL one it
// is a trap: the placeholder is a non-empty string, so "is it configured?" answers yes and the code
// takes the configured path with a garbage credential.
//
// That is exactly this module's OPENAI_API_KEY. Unreplaced, a naive check would send
// "REPLACE_ME__..." to OpenAI, get a 401, and FAIL the generation -- when the designed behaviour is
// to fall back to the proxied path and return an opaque image. So the placeholder is treated as
// ABSENT, which is what keeps the honest degradation honest.
const OPERATOR_PLACEHOLDER = "REPLACE_ME__vivijure-deploy-operator-secret";

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" when unset, unreadable, or still holding the installer's placeholder, so every
 *  not-configured guard downstream fires exactly as it would with no binding at all. */
async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  let raw: string;
  if (typeof s === "string") {
    raw = s;
  } else if (!s) {
    return "";
  } else {
    try {
      raw = await s.get();
    } catch (e) {
      console.warn("secrets-store get failed: " + (e as Error).message);
      return "";
    }
  }
  return raw.trim() === OPERATOR_PLACEHOLDER ? "" : raw;
}

async function runGenerate(
  env: Env,
  req: InvokeRequest<ImageGenerateInput>,
): Promise<InvokeResponse<ImageGenerateOutput>> {
  const input = req.input;
  if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) {
    return { ok: false, error: "image.generate: input needs a non-empty prompt" };
  }
  // Clamp the model to what this module declared. An unknown id falls back to the default rather
  // than being passed through to the binding, where it would fail as an opaque upstream error.
  const requested = req.config?.model;
  const model = typeof requested === "string" && MODELS.includes(requested) ? requested : MODELS[0];

  try {
    const { bytes, mime } = await generateImageBytes(
      {
        AI: env.AI,
        GATEWAY_ID: (await secretValue(env.GATEWAY_ID)) || undefined,
        OPENAI_API_KEY: (await secretValue(env.OPENAI_API_KEY)) || undefined,
      },
      {
        model,
        prompt: input.prompt,
        negative_prompt: input.negative_prompt,
        refs: input.refs,
        width: input.width,
        height: input.height,
      },
    );
    if (!bytes.length) {
      return { ok: false, error: `image.generate: ${model} returned zero bytes` };
    }
    return { ok: true, output: { image: { bytes_b64: bytesToBase64(bytes), mime } } };
  } catch (e) {
    // Image generation is NOT a polish step: there is no honest passthrough for "make me a picture"
    // and no previous artifact to return, so this fails loud rather than soft-degrading. The model
    // id is named so the studio can surface which one failed.
    return { ok: false, error: `image.generate: ${model} failed: ${(e as Error).message}` };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") {
      return json(MANIFEST);
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<ImageGenerateInput>;
      try {
        req = (await request.json()) as InvokeRequest<ImageGenerateInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } satisfies InvokeResponse);
      }
      if (req.hook !== "image.generate") {
        return json({ ok: false, error: `unsupported hook ${String(req.hook)}` } satisfies InvokeResponse);
      }
      return json(await runGenerate(env, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

export { MANIFEST, MODELS };
