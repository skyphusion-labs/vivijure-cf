### chore(deps): core 1.41.3 from npm

The studio now pins `@skyphusion-labs/vivijure-core` `^1.41.3` from the registry, replacing 1.41.1. Core 1.41.2 and 1.41.3 bring:

- A finished film or scatter render reports how long it ran, however late it is first polled (skyphusion-labs/vivijure-core#490).
- A pending keyframe poll no longer cancels a finished RunPod job and loses its output, the plate count record included (skyphusion-labs/vivijure-core#493).
- The plate count record keeps the backend's face-floor flag (skyphusion-labs/vivijure-core#492).
- A scatter render whose mux door is not configured sends `render.failed`, and the notify hook table names it (skyphusion-labs/vivijure-core#357).
- A 4xx from the beat door fails on the first read (skyphusion-labs/vivijure-core#358).
