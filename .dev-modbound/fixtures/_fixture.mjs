// Shared implementation for the dev-only fixture plan.enhance modules (cf#62 parity gate).
//
// These stand in for THIRD-PARTY planning modules -- software we do not ship and cannot install for
// real. They are deliberately honest about the contract rather than convenient: each serves a real
// vivijure-module/2 manifest on GET /module.json and answers POST /invoke over the real hook, so the
// studio's projection, resolution, and dispatch all run unmodified against them. Nothing about the
// STUDIO is stubbed here; only the far side of the module boundary is, which is exactly the part a
// third party would own.
//
// Dev-only. Never bound in a deployed environment.

const CANNED = {
  title: "Fixture Storyboard",
  scenes: [
    { prompt: "A wide establishing shot of a quiet harbor at dawn, mist on the water." },
    { prompt: "Close on a lone figure untying a small wooden boat, breath visible in the cold air." },
  ],
};

/** Build a fixture module worker from its manifest. */
export function fixtureModule(manifest) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return {
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/module.json") return json(manifest);

      if (request.method === "POST" && url.pathname === "/invoke") {
        let req;
        try {
          req = await request.json();
        } catch {
          return json({ ok: false, error: "invalid JSON body" });
        }
        if (req.hook !== "plan.enhance") {
          return json({ ok: false, error: `unsupported hook ${String(req.hook)}` });
        }

        const mode = typeof req.config?.mode === "string" ? req.config.mode : "enhance";
        const model = typeof req.config?.model === "string" ? req.config.model : "(none)";
        const message = typeof req.config?.message === "string" ? req.config.message.trim() : "";
        const storyboard = req.input?.storyboard;
        if (!storyboard) return json({ ok: false, error: "plan.enhance: input.storyboard required" });

        // Same sentinels as the first-party dev mock, so the validator flow is drivable here too.
        const lowered = message.toLowerCase();
        if (mode === "plan" || mode === "refine") {
          if (!message) {
            return json({ ok: false, error: `plan.enhance: config.message required for mode ${mode}` });
          }
          if (lowered.includes("#mock-badjson")) {
            return json({
              ok: true,
              output: {
                storyboard,
                notes: [`${mode} skipped: ${manifest.name} reply was not valid storyboard JSON`],
              },
            });
          }
          if (lowered.includes("#mock-fail")) {
            return json({
              ok: true,
              output: {
                storyboard: {
                  title: "Fixture Storyboard (reject branch)",
                  scenes: [{ prompt: "A valid opening shot." }, { id: "s2" }],
                },
                notes: [`${mode} via ${manifest.name}/${model}`],
              },
            });
          }
          return json({
            ok: true,
            // The title names the answering module + model, so a side-by-side reviewer can SEE which
            // module served the request rather than inferring it from a log.
            output: {
              storyboard: { ...CANNED, title: `Fixture Storyboard (${manifest.name} / ${model})` },
              notes: [`${mode} via ${manifest.name}/${model}`],
            },
          });
        }

        if (mode === "chat") {
          if (!message) return json({ ok: false, error: "plan.enhance: config.message required for chat mode" });
          return json({
            ok: true,
            output: { storyboard: { scenes: [] }, notes: [`[${manifest.name} / ${model}] ${message}`] },
          });
        }

        const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : null;
        if (!scenes || scenes.length === 0) {
          return json({ ok: false, error: "plan.enhance: input.storyboard has no scenes" });
        }
        return json({
          ok: true,
          output: {
            storyboard: {
              ...storyboard,
              scenes: scenes.map((s) => ({ ...s, prompt: `${s.prompt ?? ""} (directed by ${manifest.name})` })),
            },
            notes: [`enhanced ${scenes.length} shot(s) via ${manifest.name}/${model}`],
          },
        });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  };
}
