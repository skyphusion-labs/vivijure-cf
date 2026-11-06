### chore(deps): core 1.41.1 from npm

The studio now pins `@skyphusion-labs/vivijure-core` `^1.41.1` from the registry, replacing 1.41.0. Core 1.41.1 stops a read of a finished render from rewriting the row's `completed_at`, `execution_time_ms` and `delay_time_ms` (skyphusion-labs/vivijure-core#487). Before, a second poll of a finished keyframes-only render replaced its runtime with the time since submit, so the History row and any figure built on it read when the row was last polled, not when the render finished.
