### refactor(modules): cf-veo and cf-p-video-avatar entries no longer export generateClip

The provider call `generateClip` (cf#1105), with the `Env`, `WorkflowParams`, binding shapes and `secretValue` it needs, moves from each entry into a new `src/generate.ts`. Each Worker entry now exports only its default handler and its Workflow class, the contract `tests/worker-entry-exports-1244.test.ts` holds (vivijure-cf#1244). Behaviour is unchanged. Their `BASELINE` lines are gone (refs vivijure-cf#1308).
