import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  FINISH: DurableObjectNamespace;
  LOCAL_FINISH_TOKEN: string;
}

export class VideoFinishDoor extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      PORT: "8000",
      LOCAL_FINISH_TOKEN: env.LOCAL_FINISH_TOKEN,
    };
  }
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ready") {
      const expected = env.LOCAL_FINISH_TOKEN || "";
      return Response.json({
        ok: true,
        token_configured: expected.length > 0,
        token_len: expected.length,
      });
    }
    const isHealth = request.method === "GET" && url.pathname === "/health";
    if (!isHealth) {
      const expected = env.LOCAL_FINISH_TOKEN || "";
      const got = bearer(request);
      if (!expected || !got || expected !== got) {
        return unauthorized();
      }
    }
    return getContainer(env.FINISH, "subtitle").fetch(request);
  },
};
