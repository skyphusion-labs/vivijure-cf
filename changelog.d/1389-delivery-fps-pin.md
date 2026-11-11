### Feat: a long film pins one frame rate for every part (#1389, core#431)

The join refuses parts of different frame rates. The frame was pinned, but the rate was not, so a part whose interpolation soft-degraded shipped at 24 fps beside siblings at 48 and the join failed.

- `POST /api/render/film` takes `delivery_fps`, a whole number above 0, refused by name otherwise. Core lets it win over the rate the finish chain produced.
- `POST /api/film` takes `shared.delivery_fps`. Without it, the film works out once the rate its shared `finish_config` would ship at (core's `predictDeliveryFps`: 24, or 24 times the RIFE factor), stores it, and sends that one rate to every part. The upload-size check now predicts at that rate, not at a fixed 24.
- A film made before this has no stored rate, and its parts are sent none, as before.
