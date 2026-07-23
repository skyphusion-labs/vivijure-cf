# Security audit false positives

## Cast train UI (`public/cast.js`)

K2.7 findings on PR #198 (Phase E `/train-lora` unification):

| Finding | Rationale |
| --- | --- |
| Client POST body `{ model_family: "sdxl" }` | Authenticated studio UI only; `@skyphusion-labs/vivijure-core` whitelists `sdxl`/`wan` and checks `RUNPOD_WAN_TRAIN_ENDPOINT_ID` wiring before Wan submit |
| Wan button omits body / generic endpoint | Intentional default routing; explicit SDXL escape hatch remains; server-side family resolution is authoritative |

See vivijure-core `resolveCastTrainFamily` + `executeCastTrain` (501 when Wan unwired).
