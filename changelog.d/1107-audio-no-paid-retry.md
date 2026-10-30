### fix(modules): a failure after a track or line is bought no longer buys it again (#1107)

`music-gen` and `chatterbox` ran the provider call, the download and the R2 write in one retried step. A failed write bought the track three times at $0.15 each, or a Chatterbox line four times. The call is now its own step, and the store step retries alone. A write that keeps failing reports that the audio was not stored and will not be bought again. `dialogue-gen` is unchanged: Aura returns bytes that a step cannot checkpoint, and a repeat costs about $0.001.
