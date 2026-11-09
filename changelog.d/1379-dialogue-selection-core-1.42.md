### Feat: the caller's dialogue module reaches the film, on vivijure-core 1.42.0 (#1379, #1381)

Core moves to `^1.42.0`, which lets the caller pick the dialogue module and send it config (core#339). The studio's own mint sites never forwarded the choice, so the first dialogue module by ui.order ran (`dialogue-gen` before `chatterbox`), sent `{}`, whatever the user picked.

- The panel door, render from keyframes, retry and finalize now pass `dialogue_backend` and `dialogue_config` from the resolved overrides bag into `startFilmJob` / `startFilmFromKeyframes`. The parent film's retake passes the ones its part ran with. With no selection nothing changes: no field is sent and the first module by ui.order runs.
- An unknown name is refused when the film starts, by name (`dialogue module "<name>" is not installed`), before anything is spent.
- Not wired, because there is no dialogue input to forward: the agent door (`POST /api/render/film`, which film parents submit through) takes pre-resolved maps and has no dialogue field, and regen-shot and the parent still are keyframes-only. Adding the field to the agent door and the MCP is a follow-up.
- `tests/dialogue-selection-1379.test.ts` sweeps every mint site that forwards a resolved `finish_config` and fails when one does not forward the dialogue choice too.

Core 1.42.0 also makes the poll transport tolerance time as well as count (core#427): a run of failures fails after 3 polls AND 120 s. The #719 fixture in `tests/render-orchestrator.test.ts` fired its polls back to back and so stayed pending; it now steps them at the cron's cadence with the same assertions, and a new case pins that three fast blips stay pending (#1381).
