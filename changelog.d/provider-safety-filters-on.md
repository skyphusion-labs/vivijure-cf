### fix(modules): provider safety filters are always on

`alibaba-wan`, `alibaba-wan-lora`, `infinitetalk` and `cf-p-video-avatar` always send the provider safety filter on. It is not a config field, and a stored config that sets the old key is ignored. In `cast-image`, a provider safety flag ends the run as a plain failure with the provider's reason, on the model the run started with.
