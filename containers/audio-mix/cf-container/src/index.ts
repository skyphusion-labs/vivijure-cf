import { Container, getContainer } from "@cloudflare/containers";
import { bearerOk, readyBody } from "./gate";

interface Env {
  MIX: DurableObjectNamespace;
  LOCAL_FINISH_TOKEN: string;
}

export class AudioMixDoor extends Container<Env> {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ready") {
      return Response.json(readyBody(env.LOCAL_FINISH_TOKEN));
    }
    const isHealth = request.method === "GET" && url.pathname === "/health";
    if (!isHealth && !(await bearerOk(request.headers.get("authorization"), env.LOCAL_FINISH_TOKEN))) {
      return unauthorized();
    }
    return getContainer(env.MIX, "mix").fetch(request);
  },
};
