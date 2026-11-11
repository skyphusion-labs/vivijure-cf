// cf#1154 / cf#1159: a provider error through the AI Gateway often carries only a code ("7003: User Input Error",
// "2002: Error"). The request and the provider's reply are in the gateway log, and the binding sets the log id after
// a gateway call. The id holds no content, so it is safe to carry in an error the panel shows.
//
// A known REFUSAL is then read back from that log entry and said in plain words (refusalFromLog). The lead's read
// of the gateway log on 2026-11-05 found what the bare codes were hiding:
//   - pruna/p-video-avatar 400: "Content moderation: Blocked by content policy (violence). Enforced by the safety
//     checker" on anime shots with no violence. The provider's safety checker is NEVER switched off here.
//   - pruna/p-video-avatar 402: "Insufficient balance; add money to your gateway or use BYOK".
//   - google/veo-3.1-fast 500: "Model execution failed", no detail.
//   - google/veo-3.1-fast 400: "Invalid base64 encoded bytes", from our own request (the data URI form, fixed in
//     #1102; kept so a regression says what it is).
// A refusal must not be bought again. The doors return it from the generate step as `{ refused }` and fail it in
// parse, so neither the workflow step nor core retries it, and its words read as deterministic to core's classifier.

/** The part of the AI binding this needs. `aiGatewayLogId` is absent on a stub or an unrouted call. */
export interface GatewayLogged {
  aiGatewayLogId?: string | null;
}

/** The part of a gateway log entry the refusal map reads. */
export interface GatewayLogHead {
  status_code: number;
  response_head?: string;
}

/** The binding's gateway handle, as far as reading one log entry. */
export interface GatewayLogReader extends GatewayLogged {
  gateway?(id: string): { getLog(logId: string): Promise<GatewayLogHead> };
}

/** What a door returns from its generate step for a refusal. Plain JSON, so the workflow can checkpoint it. */
export interface ProviderRefusal {
  refused: string;
}

export function isProviderRefusal(raw: unknown): raw is ProviderRefusal {
  return !!raw && typeof raw === "object" && typeof (raw as ProviderRefusal).refused === "string";
}

/** Run one gateway call. On a throw, append the gateway log id to the SAME error, after the provider's code, so a
 *  classifier that reads the code still sees it first. With no log id the error is untouched. */
export async function namingGatewayLog<T>(ai: GatewayLogged, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const logId = ai.aiGatewayLogId;
    if (e instanceof Error && logId && !e.message.includes("(gateway log ")) e.message = `${e.message} (gateway log ${logId})`;
    throw e;
  }
}

/** Plain words for a provider refusal read from its gateway log entry, or null when the entry is not one we know.
 *  Each sentence is for a person and holds no provider text beyond a policy category word. None of them contains a
 *  word core's classifier reads as transient, so none is resubmitted. tests/provider-refusal-1154-1159.test.ts holds
 *  them against the real classifier. */
export function refusalFromLog(log: GatewayLogHead): string | null {
  const head = log.response_head ?? "";
  const policy = /content policy \(([a-z][a-z ,_-]{0,40})\)/i.exec(head);
  if (policy || /content moderation|safety checker/i.test(head)) {
    const category = policy ? policy[1].trim().toLowerCase() : "";
    const why = category === "violence" ? "as violent" : category ? `under its ${category} rule` : "under its content rules";
    return `The video service refused this shot ${why}, by its own safety check. Change the shot's wording or pick another style.`;
  }
  if (log.status_code === 402 || /insufficient balance/i.test(head)) {
    return "The AI credit balance ran out, so the video service did not run. Add credit, then run the shot again.";
  }
  if (/invalid base64/i.test(head)) {
    return "The studio sent the start image in a form the video service could not read. This is a studio bug; please report it.";
  }
  if (log.status_code >= 500 && /model execution failed/i.test(head)) {
    return "The video service failed on this shot and gave no reason. Run it again, or pick another style.";
  }
  return null;
}

/** Read a failed call's gateway log entry and map it. Null when there is no log id, no reader, no entry yet, or an
 *  entry we do not know: the caller then keeps the provider's own error, as before. The entry can lag the call, so
 *  this reads up to `attempts` times, `waitMs` apart. Never throws. */
export async function readRefusal(
  ai: GatewayLogReader,
  gatewayId: string,
  { attempts = 3, waitMs = 2000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<string | null> {
  const logId = ai.aiGatewayLogId;
  if (!logId || typeof ai.gateway !== "function") return null;
  for (let i = 0; i < attempts; i++) {
    try {
      const entry = await ai.gateway(gatewayId).getLog(logId);
      return refusalFromLog(entry);
    } catch {
      if (i < attempts - 1) await sleep(waitMs);
    }
  }
  return null;
}

/** A gateway call that returns `{ refused }` for a refusal its log names, and otherwise behaves as namingGatewayLog:
 *  the result on success, the provider's own error (with its log id) on anything else. */
export async function callWithRefusals<T>(
  ai: GatewayLogReader,
  gatewayId: string,
  call: () => Promise<T>,
  opts?: Parameters<typeof readRefusal>[2],
): Promise<T | ProviderRefusal> {
  try {
    return await namingGatewayLog(ai, call);
  } catch (e) {
    const refused = await readRefusal(ai, gatewayId, opts);
    if (refused) return { refused: `${refused} (gateway log ${ai.aiGatewayLogId})` };
    throw e;
  }
}

/** Parse step: a refusal fails the render here, once, with its plain words. */
export function failOnRefusal(raw: unknown): void {
  if (isProviderRefusal(raw)) throw new Error(raw.refused);
}
