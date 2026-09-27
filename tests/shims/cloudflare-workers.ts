// Test shim for the `cloudflare:workers` runtime module so plain-node Vitest can import module workers
// that extend WorkflowEntrypoint. The Workflow's run() is exercised in the Workers runtime, not here;
// these tests cover the fetch handler (submit/poll), which only needs the class to be constructible.
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected env: Env;
  protected ctx: unknown;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export type WorkflowEvent<T> = { payload: T };
export interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

// DurableObject, for the same reason WorkflowEntrypoint is here. `@cloudflare/containers` builds
// `Container` on top of `DurableObject` from this module, so once the studio entrypoint exports a
// container-backed Durable Object class (FinishContainer, #797) EVERY node-environment test that
// imports src/index.ts loads that chain. Without this export the alias resolves `DurableObject` to
// undefined and the whole suite dies at import time with "Class extends value undefined is not a
// constructor or null" -- which is what happened, in tests that have nothing to do with containers.
//
// Minimal on purpose, exactly like WorkflowEntrypoint above: these tests only need the class to be
// CONSTRUCTIBLE so the import graph resolves. Container behaviour (lifecycle, sleepAfter,
// renewActivityTimeout, containerFetch) is exercised in the Workers runtime and by the
// `wrangler deploy --dry-run` bundle gate, never here. Do not grow this into a fake container.
export class DurableObject<Env = unknown> {
  protected env: Env;
  protected ctx: unknown;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// WorkerEntrypoint, and note this is NOT the same thing as WorkflowEntrypoint above -- the names
// differ by three letters and mean different runtime base classes, which is exactly the trap.
// `@cloudflare/containers` imports BOTH `DurableObject` and `WorkerEntrypoint` from this module and
// evaluates `class ContainerProxy extends WorkerEntrypoint` at MODULE LOAD, so shimming only
// DurableObject still dies with the identical "Class extends value undefined" message and looks like
// the first fix did not work. Both are required.
export class WorkerEntrypoint<Env = unknown, Options = unknown> {
  protected env: Env;
  protected ctx: unknown;
  protected options?: Options;
  constructor(ctx: unknown, env: Env, options?: Options) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
  }
}
