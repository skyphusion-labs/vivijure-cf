### fix(ci): the smoke citation prints before any verdict

The container smoke script printed the image id after it read the published port, and a container that died first exited before that line. The control then failed on a race and blocked a tag deploy. The citation now prints right after the container starts. A new case forces the early path with a docker shim. See the v1.39.0 tag run.
