// The control plane's ONE injectable seam (#52).
//
// This is the productionReindexDeps discipline from the studio: production has exactly one wiring
// function, tests replace the whole bundle, and there is no second code path that only tests take.
// A stubbed dep set proves a decision path; it never proves the shipped artifact, which is why
// productionDeps() is what the live wrangler dev verify drives.

import type { ControlPlaneEnv } from "./env";
import type { MailSender } from "./email";
import { posternSender } from "./email";
import type { ControlPlaneStore } from "./store";
import { D1Store } from "./store-d1";

export interface ControlPlaneDeps {
  store: ControlPlaneStore;
  mailer: MailSender;
  /** Outbound fetch (SSO token exchange, RunPod probes). Injectable so tests never hit the network. */
  fetch: typeof fetch;
  now(): number;
}

export function productionDeps(env: ControlPlaneEnv): ControlPlaneDeps {
  return {
    store: new D1Store(env.CP_DB),
    mailer: posternSender(env),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    now: () => Date.now(),
  };
}
