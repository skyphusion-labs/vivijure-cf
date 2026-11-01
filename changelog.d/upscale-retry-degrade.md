### fix(finish-upscale): ask again before a shot stands out in the film

A door that soft-degraded an upscale passed the small clip through at once, so one shot could sit in a film beside upscaled ones. The step now reports `transient`, so the core holds and re-dispatches it. Only when that runs out does the passthrough stand, and the film's report names it.
