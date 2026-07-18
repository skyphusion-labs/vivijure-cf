// Fixture: a planning module whose model ids GO AWAY.
//
// Bound only in the `staleid` scenario. Save a project pref on one of these ids, restart the harness
// into any other scenario, and the saved id is genuinely absent from the catalog -- the un-stubbable
// version of "a stale saved id", as opposed to a test that mutates a stubbed catalog in place.
import { fixtureModule } from "./_fixture.mjs";

export default fixtureModule({
  name: "legacy-planner",
  version: "0.9.0",
  api: "vivijure-module/2",
  hooks: ["plan.enhance"],
  provides: [{ id: "legacy", label: "Legacy Planner (going away)" }],
  config_schema: {
    model: {
      type: "enum",
      values: ["legacy/model-going-away", "legacy/model-also-going-away"],
      default: "legacy/model-going-away",
      label: "model",
    },
  },
  ui: { section: "plan", order: 40 },
});
