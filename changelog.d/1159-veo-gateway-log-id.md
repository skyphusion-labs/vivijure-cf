### fix(cf-veo): a failed call names its gateway log

cf-veo failed shots with `AiGatewayError: 2002: Error` and nothing else. A failed call now ends with `(gateway log <id>)`, which points at the request and the provider's reply in the AI Gateway log. The id holds no content. The provider code stays first, so the retry classifier reads it as before. The log id handling cf-p-video-avatar got in #1157 moves to one shared helper (`modules/_shared/gateway-log.ts`) that both doors use. Refs cf#1159.
