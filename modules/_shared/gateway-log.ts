// cf#1154 / cf#1159: a provider error through the AI Gateway often carries only a code ("7003: User Input Error",
// "2002: Error"). The request and the provider's reply are in the gateway log, and the binding sets the log id after
// a gateway call. The id holds no content, so it is safe to carry in an error the panel shows.

/** The part of the AI binding this needs. `aiGatewayLogId` is absent on a stub or an unrouted call. */
export interface GatewayLogged {
  aiGatewayLogId?: string | null;
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
