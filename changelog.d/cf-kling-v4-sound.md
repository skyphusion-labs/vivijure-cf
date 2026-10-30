### fix(modules): cf-kling-v4 declares the sound the model returns

The door said silent, and the model returns its own soundtrack with no field to turn it off. The door now says so and reports `has_audio`. A board with a spoken line is still refused.
