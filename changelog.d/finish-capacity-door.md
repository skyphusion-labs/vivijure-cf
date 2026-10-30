### fix(finish): name a full finish tier, and route retries to one instance

The video-finish door now answers 429 with `capacity_exhausted` when the container instance limit refuses a submit. The base Container class reports that limit as a 500, so core could not tell it from a crash. Other refusals pass through unchanged.

When core names the film (`x-vivijure-finish-affinity`), the routing key comes from the film id, so a retry and the mux leg reach one instance. Without the header the door mints a random key as before. Retrying at capacity needs the core release that reads the 429; with the current pin the film still fails, with a 429 in place of a 500.
