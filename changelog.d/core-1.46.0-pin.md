### chore(deps): core 1.46.0 from npm

The studio now pins `@skyphusion-labs/vivijure-core` `^1.46.0` from the registry, replacing 1.45.0. Core 1.46.0 reads finish conventions only from a module's `finish_artifacts`; the binding-name fallbacks are gone (vivijure-cf#879, core#543). Every finish module this studio ships declares `finish_artifacts`, and the long-film default rate already passes them (#1420). Dispatch discovery honours `TENANT_MODULE_PREFIX` (core#542, the core side of #1412); a studio without the prefix set dispatches as before.
