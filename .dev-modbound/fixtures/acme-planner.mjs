// Fixture: a THIRD-PARTY planning module that declares its own model enum.
// Proves the catalog is a projection, not "our models plus a hardcoded list".
import { fixtureModule } from "./_fixture.mjs";

export default fixtureModule({
  name: "acme-planner",
  version: "3.1.0",
  api: "vivijure-module/2",
  hooks: ["plan.enhance"],
  provides: [{ id: "acme", label: "ACME Planning" }],
  config_schema: {
    model: {
      type: "enum",
      values: ["acme/planner-xl", "acme/planner-mini"],
      default: "acme/planner-xl",
      label: "model",
    },
  },
  ui: { section: "plan", order: 20 },
});
