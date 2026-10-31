**Fix: a failed cf-p-video-avatar call names its gateway log (#1154).**

A provider `7003` carries no detail, so the failure could not be diagnosed. The error now carries the AI Gateway log id, which holds no content and points to the request.
