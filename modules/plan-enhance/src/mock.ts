// Dev-only planner AI mock (issue #411 dev-parity), vendored into the module.
//
// It moved HERE from the studio in cf#62. When the planner stopped dispatching to providers itself
// and started invoking this module, the studio-side mock lost its call site -- the module now owns
// every model call, so the module has to own the mock too, or the fully-local dev fleet loses the
// planner re-prompt flow it was built for. Same contract as the studio version it replaces.
//
// Lets the module-bound LOCAL dev env exercise the planner re-prompt UI/state machine
// (submit -> validator reject -> re-prompt -> resubmit) WITHOUT a live model call. Workers AI is
// remote-only and the crew dev token cannot create an edge-preview, so a fully-local dev fleet has
// no AI binding; this fills that one gap.
//
// HONEST BY DESIGN: it replaces ONLY the network dispatch. The canned completion it returns still
// flows through the real parse -> validate pipeline, so a "pass" is a genuinely valid storyboard and
// a "fail" is the genuine validator output. It is NOT a Workers AI stand-in.
//
// GATED on the PLANNER_AI_MOCK var (dev only). UNSET in prod, so the live path is unchanged.

export function plannerAiMockEnabled(env: { PLANNER_AI_MOCK?: string }): boolean {
  return env.PLANNER_AI_MOCK === "1" || env.PLANNER_AI_MOCK === "true";
}

// The branch is driven from the planner UI via a sentinel in the brief / refine instruction:
//   contains "#mock-badjson" -> non-JSON output (drives the "not valid storyboard JSON" branch)
//   contains "#mock-fail"    -> a storyboard that FAILS validation (drives the reject/re-prompt branch)
//   otherwise                -> a minimal VALID storyboard (the pass branch)
export function mockPlannerRaw(userMessage: string): string {
  const msg = (userMessage || "").toLowerCase();
  if (msg.includes("#mock-badjson")) {
    return "Sure, here is your storyboard: (dev mock deliberately-not-JSON output)";
  }
  if (msg.includes("#mock-fail")) {
    // scene 2 omits the required `prompt` -> real validateStoryboard structured failure.
    return JSON.stringify({
      title: "Dev Mock Storyboard (reject branch)",
      scenes: [{ prompt: "A valid opening shot: a quiet harbor at dawn." }, { id: "s2" }],
    });
  }
  return JSON.stringify({
    title: "Dev Mock Storyboard",
    scenes: [
      { prompt: "A wide establishing shot of a quiet harbor at dawn, mist on the water." },
      { prompt: "Close on a lone figure untying a small wooden boat, breath visible in the cold air." },
    ],
  });
}
