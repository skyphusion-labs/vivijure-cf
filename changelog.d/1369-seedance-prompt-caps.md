### fix(cf-seedance): send prompts up to the published cap, not 2000 characters (#1369)

The four vendored Seedance schemas capped `prompt` at 2000 characters. Cloudflare's published schemas now allow 25000 (2.5) and 10000 (2.0, 2.0-fast, 2.0-mini), so `composePrompt` cut prompts the vendor would accept, and nothing reported the cut. The schemas are re-vendored from the live URLs; `prompt.maxLength` is the only change in each file. `tests/cf-seedance-schema.test.ts` pins the four published caps and checks that a 5000-character prompt is sent whole on every model.
