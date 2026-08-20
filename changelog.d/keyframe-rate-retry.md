### fix(keyframe): retry a 429/5xx on the next poll tick

Nano Banana 429 under a 14-film fan-out failed the whole kling film on shot 8.
A rate-limit leaves the shot at the front of the queue and returns pending,
up to 5 ticks. Persistent 429 still hard-fails. CSAM never retries.
