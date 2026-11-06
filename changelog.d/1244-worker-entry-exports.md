### fix(cloud-keyframe): the module worker starts under a module-bound wrangler dev

The cloud-keyframe Worker entry exported a number (`FILM_DOC_GRACE_MS`). workerd reads every export of an entry as an entrypoint and refused the worker, so `.dev-modbound/dev-modbound.sh` did not start. The constant now lives in a leaf module. A new test finds every Worker entry from the wrangler configs, imports it, and fails on any export workerd would refuse; it also fails on a new non-class named export, against a baseline of the existing ones that may only shrink (vivijure-cf#1244).
