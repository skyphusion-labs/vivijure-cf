### feat(plan-enhance): reach Opus through the AI binding without a token

With `GATEWAY_ID` and the new opt-in var `ENHANCE_OPUS_BINDING = "1"`, plan-enhance calls Opus with `env.AI.run` and the AI Gateway catalog id, so it needs no `CF_AIG_TOKEN`. A deployment with a token is unchanged, and so is one with a gateway and no opt-in, which stays on the free local model. `GET /ready` reports the transport as `opus`.
