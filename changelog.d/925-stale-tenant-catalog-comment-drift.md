### docs(modules): correct the stale cp#284 catalog claim in 10 wrangler.toml, and the infinitetalk header (cf#925)

Comment-only; no binding, no `compatibility_date`, no code path changed.

- Ten module `wrangler.toml` files (`alibaba-wan`, `alibaba-wan-lora`, `google-veo`, `kling`,
  `kling-o1-r2v`, `minimax-hailuo`, `narration-gen`, `seedance`, `vidu-q3`, `infinitetalk`) carried
  a byte-identical block asserting "TENANT_MODULE_CATALOG is six entries, none of them these" and
  concluding "every row this binding writes is our own traffic". cp#284 was answered "tenants get
  the cost door" by cp#317 and the comment never moved: measured against
  `vivijure-control-plane@main` by the array BOUNDS, the catalog is 17 entries and eight of them are
  exactly these modules. `npm run check:catalog` prints the same 17 from the live authority.
- The cross-tenant `TELEMETRY_DB` write that block predicted has not happened, and the replacement
  says why it structurally cannot: `scripts/build-module-release.ts` publishes a manifest of
  `{module, worker.sha256, compatibility_date, compatibility_flags}` and no bindings, so the plane's
  binding array is the complete set a tenant module gets, and it binds `R2_RENDERS` to the tenant
  bucket and `TELEMETRY_DB` to the tenant D1, throwing rather than falling back in both cases. The
  two changes that WOULD break it are named in the new block.
- `modules/infinitetalk/wrangler.toml` and `modules/infinitetalk/src/index.ts` both described the
  worker as "Kuaishou Kling V2.1 I2V Pro on RunPod". It is MeiGen-AI InfiniteTalk on the RunPod
  public endpoint `api.runpod.ai/v2/infinitetalk`. Both also called it "the second motion.backend
  backend"; the live projection serves 15 on that hook.

Found while establishing what blocks a hosted tenant from lip-synced dialogue
(vivijure-control-plane#524).
