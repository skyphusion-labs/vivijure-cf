// vivijure-studio: the Worker entry (wrangler `main`).
//
// workerd reads EVERY export of an entry as an entrypoint (cf#1244), so this module exports only the
// default handler and the classes wrangler binds. The studio itself (route table, handlers, the
// sweep pass) lives in ./studio, and tests import those from there (vivijure-cf#1308).
import { studioWorker } from "./studio";

// The Durable Object class backing the video-finish Cloudflare Container (#797). This export
// is NOT optional and is not decoration: `wrangler deploy` rejects a durable_objects binding
// whose class is not exported from the entrypoint, so removing this line arms a deploy failure
// that only surfaces at the next `v*` tag and takes the whole studio release with it.
export { FinishContainer } from "./finish-container";
// wrangler [[workflows]] class_name "ShotWorkflow". The deploy rejects a workflow
// whose class is not exported from the entrypoint.
export { ShotWorkflow } from "./shot-workflow";

export default studioWorker;
