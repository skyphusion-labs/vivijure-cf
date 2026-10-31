### fix(modules): dialogue-gen is the default dialogue door

`dialogue-gen` now sorts ahead of `chatterbox`. A provider queue on `chatterbox` was failing spoken films, and the core picks the door by order with no per-film choice (vivijure-cf#1164).
