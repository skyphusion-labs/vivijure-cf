// Fixture: a third-party planning module with NO config_schema.model enum.
// It must still be SELECTABLE, listed under its own name/label, with the MODULE NAME itself as the
// model id -- the resolvePlanningTarget byName branch. This is the path Joan asked to exercise
// through the real UI rather than only in a unit fixture.
import { fixtureModule } from "./_fixture.mjs";

export default fixtureModule({
  name: "bespoke-planner",
  version: "0.1.0",
  api: "vivijure-module/2",
  hooks: ["plan.enhance"],
  provides: [{ id: "bespoke", label: "Bespoke Planner" }],
  ui: { section: "plan", order: 30 },
});
