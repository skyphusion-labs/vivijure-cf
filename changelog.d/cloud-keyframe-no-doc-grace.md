### fix(cloud-keyframe): a film run with no film doc stops after a grace period

A drawing run for a film treats a film doc still missing after 6 minutes as a film that is over, and stops before the next paid step. A run with no film id is not affected.
