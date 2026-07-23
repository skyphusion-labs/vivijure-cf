# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Operator-controlled deploy inputs

`deploy.sh` substitutes `DEPLOY_HOSTNAME` and store ids via sed. Values come from the operator's shell environment at deploy time, not from untrusted HTTP input. A malicious operator already controls the Worker.

## Demo gallery video URLs

`demo-steer.js` loads `output_key` URLs from demo render rows written by the studio's demo queue. Demo output origins are operator-configured (`artifactOrigin`); this is not an open redirect from user-supplied keys.

## Control-plane bound InvokeContext

`InvokeRequest.context.project` is set by the authenticated control plane from the render job row (`vivijure-module/2` `InvokeContext`), not from untrusted module HTTP clients. Module workers are internal service bindings; CF Access gates the studio edge. Forwarding `context.project` into RunPod bodies **enables** backend R2 tenancy (`check_scoped_job_key` in vivijure-backend), it does not bypass it. Chain `clip_key` / `audio_key` values are produced by upstream stages under the same job; the GPU worker re-validates them against `project` before any store I/O.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 repo | deploy.sh sed without escaping | Operator-controlled deploy env |
| 2026-07-23 | K3 repo | Demo gallery arbitrary video URLs | Demo queue rows; operator-configured artifact origin |
| 2026-07-23 | K3 verify ~18:04 | Demo mode opens ALL GET endpoints | AUTH_MODE=demo homelab gallery; operator-controlled |
| 2026-07-23 | K3 verify ~18:04 | Staged-key path skips magic-byte validation | JSON {key,mime} path trusts operator-staged R2 keys |
| 2026-07-23 | K3 verify ~18:04 | Spend rate limiter omits planner/chat | Best-effort spend cap; CF Access + account auth at edge |
| 2026-07-23 | K3 verify ~18:04 | Demo render jobId client-supplied | Demo mode; capped queue rows |
| 2026-07-23 | K3 verify ~18:04 | deploy.sh strip_val / STORE_ID grep | Operator deploy script |
| 2026-07-23 | K2.7 PR #205 | Unvalidated project forwarded (finish-upscale/lipsync) | Control-plane bound `InvokeContext.project`; enables backend tenancy binding |
| 2026-07-23 | K2.7 PR #205 | clip_key/audio_key unconstrained object paths | Backend `check_scoped_job_key` binds reads to `project`; chain keys from same render job |
| 2026-07-23 | K2.7 PR #206 | audio_key + project to RunPod without isolation proof | Same InvokeContext + backend scoped-key checks; #205 pattern for speech chain |
| 2026-07-23 | K2.7 PR #206 | Poll token base64 leaks audio_key | Internal async poll token; module dispatch namespace + finish-chain pattern (finish-rife) |
