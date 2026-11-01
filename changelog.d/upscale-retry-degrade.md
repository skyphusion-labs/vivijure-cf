### fix(finish-upscale): ask again before a shot stands out in the film

A door that soft-degraded an upscale passed the small clip through at once, so one shot could sit in a film beside upscaled ones. For a cause that may pass, the step now reports `transient`, so the core holds and re-dispatches it. A wall-clock guard expiry gets no retry: each try can run 570 s, about $0.55, and a clip too heavy usually fails them all. It stands as a limit on the film's report, for a person to retry.
