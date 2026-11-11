import { Container, getContainer } from "@cloudflare/containers";
import { bearerOk, readyBody } from "./gate";
import { forwardToInstance } from "./routing";

interface Env {
  FINISH: DurableObjectNamespace;
  LOCAL_FINISH_TOKEN: string;
}

export class VideoFinishDoor extends Container<Env> {
  defaultPort = 8000;
  // Same as the studio door. Only this film's polls keep its instance awake, and a poll can be minutes
  // apart, so a shorter timer could put the instance to sleep under its own running job.
  sleepAfter = "10m";

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
    return forwardToInstance(request, (name, req) => getContainer(env.FINISH, name).fetch(req));
  },
};
