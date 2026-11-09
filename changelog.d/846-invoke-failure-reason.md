### feat(modules): modules declare `reason` on the invoke failures they can name (#846)

131 invoke-arm `ok: false` returns across 33 modules now set the closed `reason` field: `bad-input` (invalid JSON body, a missing or malformed input field, an input over a cap), `unsupported` (a hook the module does not serve), and `not-configured` (an inline check on GATEWAY_ID, the RunPod credential, or a backend URL). Core's `classifyInvokeFailure` reads the declared class before the sentence, so rewording these messages can no longer move a retry decision. All three classes are deterministic and so is the prose reading of every sentence, so no retry decision changes today.

Failures whose class the module does not know stay without `reason` and keep the prose road: `submit failed: <message>`, `could not start generation workflow`, `could not persist run state`, and `credentialProblem(...)`, which returns two different conditions behind one string. `PollResponse` and `CancelResponse` carry no `reason` (core#306).

`tests/invoke-failure-reason-adopted-846.test.ts` drives every module's real `/invoke` and `/poll` handlers, rejects a value outside the closed set, rejects `reason` on a poll or cancel literal, and fails if a declared class disagrees with the prose disposition of its sentence.
