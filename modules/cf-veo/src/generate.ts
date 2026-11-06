// cf-veo provider call: the binding shapes, Env, WorkflowParams and generateClip (cf#1105), the
// one step that buys a clip. A leaf module (vivijure-cf#1308): a Worker entry may export only
// classes and its default handler (cf#1244), so the entry and its tests import these from here.
import type { MotionBackendInput } from "./contract";
import { MODEL, buildParams, keyframeImageInput, type ModuleConfig } from "./params";
import { callWithRefusals, type GatewayLogReader } from "../../_shared/gateway-log";

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
  // Set by the binding after a gateway call. Absent on a stub or an unrouted call.
  aiGatewayLogId?: string | null;
  // cf#1154: the binding's gateway handle, used only to read one failed call's own log entry.
  gateway?: GatewayLogReader["gateway"];
}

export interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string }>;
}
export interface WorkflowBinding {
  create(options?: { id?: string; params?: WorkflowParams }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

export interface Env {
  AI: AiRun;
  GATEWAY_ID: SecretsStoreSecret;
  R2_RENDERS: R2Bucket;
  I2V_WORKFLOW: WorkflowBinding;
}

export interface WorkflowParams {
  job_id: string;
  project: string;
  shot_id: string;
  seconds: number;
  input: MotionBackendInput;
  config: ModuleConfig;
}

export async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

/** The provider call. Its own workflow step, so nothing after it can buy it again (cf#1105). */
export async function generateClip(env: Env, params: WorkflowParams): Promise<unknown> {
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID not configured");
  const modelParams = buildParams(params.input, params.config, await keyframeImageInput(params.input.keyframe_url));
  // A refusal its gateway log names (content policy, credit, a provider failure) comes back as { refused } and
  // fails in parse, so it is never bought again. Anything else keeps the provider's own error and its log id.
  return callWithRefusals(env.AI, gatewayId, () => env.AI.run(MODEL, modelParams, { gateway: { id: gatewayId } }));
}
