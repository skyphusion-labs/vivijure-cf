### fix(film): a shot that lost a finish step reaches the film's report

A shot whose upscale soft-degraded looked finished from everything on a long film. The film and each part now count such shots in `finish_degraded`, the part gives the reasons, `degraded` says so in text, and the shot row names its own. The panel's existing line shows that text.
