### fix(image-generate): xAI and Recraft V4 chat images stop failing with 7003

`xai/grok-imagine-image` and `recraft/recraftv4` failed every chat image call with `7003: User Input Error`. The AI Gateway log held the provider errors. xAI refuses its default URL output for a zero-data-retention team, so the module now sends `response_format: "b64_json"` and decodes the base64 it gets back instead of fetching it. Recraft V4 refuses any `style`, so the module no longer sends one to V4. The proxied output is now read as a URL, a data URL or raw base64, and base64 that does not decode to an image fails loud. `image-generate` is 0.1.2.

The other two causes in #1141 were fixed before this change: the output shape by #1148, and the 1 MiB response cap by core 1.29.0, which reads `image.generate` through a 32 MiB cap.

The studio file `src/proxied-image-params.ts` is removed. No code imported it, only its own test, and it still carried the Recraft `style` that V4 refuses.
