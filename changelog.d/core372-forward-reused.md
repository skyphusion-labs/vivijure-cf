### fix(keyframe): forward the backend's reused flag to the core

The keyframe module dropped `reused`, so the core would stamp its config provenance on a still the job did not draw (core#372).
