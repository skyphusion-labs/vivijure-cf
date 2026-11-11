// cf#904: a hook in the catalog that NO module in this repo provides is reported unavailable until
// something installed serves it.
//
// THE FAILURE THIS CLOSES. `GET /api/modules` lists `speech` in `catalog` ("clean / enhance dialogue
// audio"), and nothing serves it: cf#786 removed `speech-upscale`, the only provider, and no module
// in this tree declares the hook. An agent told to read that projection first saw a capability on
// offer that no render could deliver, and cf#836's per-stage `speech` degrade key could never be
// written, because the stage never runs.
//
// WHY THE cf#98 CHANNEL AND NOT A CATALOG EDIT. Ruled on cf#904: stop advertising it, and do not
// foreclose either of Conrad's open calls (retire the hook, or fund a provider). The catalog is
// core's static contract; dropping `speech` from it would remove the hook for a third-party module
// too. `host.hooks_unavailable` is the existing "this host cannot serve this" channel, and the
// entry here is DERIVED from what is installed: the moment a module serving `speech` is discovered,
// the key disappears with no code change. Absent still means available.
//
// WHY A NAMED LIST AND NOT "EVERY HOOK WITH ZERO INSTALLED MODULES". A self-host that has not
// installed, say, a finish module is a different fact from a hook nothing in the project provides,
// and the panel already renders that case as a skipped stage. Widening this to every empty hook
// would mark ordinary optional stages as host faults. The list is held equal to the tree by
// tests/providerless-hooks-904.test.ts: a hook that gains a first-party provider must leave it, and a
// hook that loses its last one must join it.

import { servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import type { HookName } from "@skyphusion-labs/vivijure-core/modules/types";

/** Catalog hooks that no module under modules/ declares. */
export const PROVIDERLESS_HOOKS = ["speech"] as const satisfies readonly HookName[];

/** Printed verbatim by the panel (cf#98). Says what the user still gets, so it does not read as broken. */
export const PROVIDERLESS_HOOK_REASON: Record<(typeof PROVIDERLESS_HOOKS)[number], string> = {
  speech:
    "No speech module is available on this studio, so dialogue clean-up is skipped and dialogue audio is used as generated.",
};

/** One `hooks_unavailable` entry per providerless hook that nothing discovered serves. */
export function providerlessHooksUnavailable(modules: RegisteredModule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const hook of PROVIDERLESS_HOOKS) {
    if (servingForHook(modules, hook).length === 0) out[hook] = PROVIDERLESS_HOOK_REASON[hook];
  }
  return out;
}
