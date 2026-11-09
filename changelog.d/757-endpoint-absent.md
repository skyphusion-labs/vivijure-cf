### fix(finish-upscale): a missing RunPod endpoint says so in a structured field (#757)

A finish-upscale bound to a RunPod endpoint that does not exist used to degrade as `runpod-run-failed: HTTP 404` with `failure.code: "refused"`, the same shape as a bad request. It now degrades as `runpod-endpoint-absent`, with `failure: { kind: "permanent", code: "endpoint_absent" }` and a detail that says the door has no backend, which the film report shows. Still a soft degrade: the chain keeps the input clip.

It fires only on RunPod's measured answer for a missing endpoint: HTTP 404 with `detail` exactly `endpoint not found` (measured with a valid key on 2026-11-09). A 404 with any other detail, a door's 404, and every other status are unchanged. The classifier is `modules/_shared/runpod-endpoint-absent.ts`, so other RunPod modules can adopt it.
