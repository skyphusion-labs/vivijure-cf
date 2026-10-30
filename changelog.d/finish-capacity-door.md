### fix(finish): name a full finish tier, and route retries to one instance

The video-finish door now answers 429 with `capacity_exhausted` when the container instance limit refuses a submit. The base Container class reports that limit as a 500, so core could not tell it from a crash. Other refusals pass through unchanged.

When core names the film (`x-vivijure-finish-affinity`), the routing key comes from the film id, so a retry and the mux leg reach one instance. Without the header the door mints a random key as before. With core 1.27.0 a full tier now holds the film in its phase and retries, up to 6 hours, in place of failing it.
