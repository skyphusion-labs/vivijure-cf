// POST /api/chat image generation, dispatched to an installed image.generate module (cf#129 ph2).
//
// Port of vivijure-local/src/chat-image-module.ts. The studio holds no image model names and no
// provider routing: it resolves the chosen model id to the module that DECLARED it and invokes the
// hook. Same mechanism as chatComplete for text, no module name special-cased, so a third-party
// image module works on the identical path.
//
// THE CORE OWNS PERSISTENCE. The module returns bytes and holds no bucket binding; this file writes
// them via putChatArtifact, which targets the bucket GET /api/artifact serves. That is cf#140 made
// structural rather than patched: the defect was a successful write into a bucket the serve route
// does not read, which no amount of green gates would have surfaced.

import { invokeModule, resolveFetcher, validateConfig } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import type { Env } from "./env";
import { putChatArtifact, type OutputArtifact } from "./chat-artifacts";
import { base64ToBytes } from "./utils";
import { resolveCatalogTarget } from "./module-catalog";

export interface ChatImageAttachment {
  type?: string;
  data?: string;
  mime?: string;
  filename?: string;
}

export interface ChatImageArgs {
  model: string;
  user_input: string;
  system_prompt?: string;
  attachments?: ChatImageAttachment[];
}

export type ChatImageResult =
  | {
      ok: true;
      model: string;
      output: string;
      output_artifact: OutputArtifact;
      latency_ms: number;
      ai_gateway_log_id: string | null;
      module: string;
    }
  | { ok: false; error: string; model: string };

interface ImageGenerateOutput {
  image?: { bytes_b64?: string; mime?: string };
}

function attachmentDataUrls(args: ChatImageArgs): string[] {
  const out: string[] = [];
  for (const att of args.attachments ?? []) {
    if (att.type !== "image" || !att.data) continue;
    if (att.data.startsWith("data:")) out.push(att.data);
    else if (att.mime) out.push(`data:${att.mime};base64,${att.data}`);
  }
  return out;
}

export async function chatImageViaModule(
  env: Env,
  modules: RegisteredModule[],
  args: ChatImageArgs,
): Promise<ChatImageResult> {
  const target = resolveCatalogTarget(modules, "image.generate", args.model);
  if (!target) {
    return {
      ok: false,
      error: `no image.generate module serves model "${args.model}" (install an image module)`,
      model: args.model,
    };
  }
  const mod = modules.find((m) => m.name === target.moduleName);
  if (!mod) return { ok: false, error: `image module ${target.moduleName} not found`, model: args.model };

  const fetcher = resolveFetcher(env as unknown as Record<string, unknown>, mod.binding);
  if (!fetcher) {
    return { ok: false, error: `image module ${mod.name} (${mod.binding}) is not bound`, model: args.model };
  }

  const start = Date.now();
  const r = await invokeModule<Record<string, unknown>, ImageGenerateOutput>(fetcher, {
    hook: "image.generate",
    input: {
      prompt: args.user_input,
      // The chat composer's "system prompt" is the negative prompt on the image path; that is what
      // it always meant here, and the module contract now names it honestly.
      negative_prompt: args.system_prompt,
      refs: attachmentDataUrls(args),
    },
    config: {
      ...validateConfig(mod.config_schema, {}),
      model: target.configModel ?? target.modelId,
    },
    context: { project: "chat", job_id: crypto.randomUUID() },
  });

  if (!r.ok) {
    return {
      ok: false,
      error: ("error" in r ? r.error : undefined) || "image module returned no output",
      model: args.model,
    };
  }

  // A module MAY answer async (ok:true + pending + poll). This path does not poll: chat image
  // generation is request-scoped and the panel waits on it. Rejecting by name is honest; treating a
  // pending envelope as a result would store nothing and report success.
  if ("pending" in r) {
    return {
      ok: false,
      error: `image module ${mod.name} answered asynchronously (pending/poll), which the chat image path does not support`,
      model: args.model,
    };
  }

  const image = r.output?.image;
  if (!image?.bytes_b64 || !image.mime) {
    return { ok: false, error: `image module ${mod.name} returned no image bytes`, model: args.model };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(image.bytes_b64);
  } catch {
    return { ok: false, error: `image module ${mod.name} returned undecodable base64`, model: args.model };
  }
  if (!bytes.length) {
    return { ok: false, error: `image module ${mod.name} returned zero bytes`, model: args.model };
  }

  const output_artifact = await putChatArtifact(env, image.mime, bytes);
  return {
    ok: true,
    model: args.model,
    output: "",
    output_artifact,
    latency_ms: Date.now() - start,
    ai_gateway_log_id: null,
    module: mod.name,
  };
}
