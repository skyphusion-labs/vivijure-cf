### feat(infinitetalk): a stopped film can stop a clip job

The module declares `cancelable` and takes `POST /cancel` with a poll token. It calls `POST /cancel/<job>` on the public endpoint. Whether RunPod still charges a job cancelled while running is not measured. The module needs its own deploy.
