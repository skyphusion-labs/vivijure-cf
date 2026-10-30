### chore(deps): undici 7.30.1

The root npm override now pins undici to 7.30.1. That release fixes five development-scope advisories in the root lockfile: cache poisoning via cross-origin redirects (GHSA-4w7w-5xrc-9h26), a TLS certificate validation bypass (GHSA-2m5v-pch6-74hx), denial of service via TLS 1.2 renegotiation (GHSA-qrxm-fqhp-jwvm), unbounded WebSocket PONG buffering (GHSA-9fm3-97px-rjf6), and denial of service via excessive content-encodings (GHSA-xjj6-f33q-929c).
