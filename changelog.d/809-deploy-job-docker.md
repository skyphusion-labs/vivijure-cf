### ci: give the deploy job Docker, because the container image is now a build input (cf#809)

cf#798 added a `[[containers]]` block whose `image` is a local Dockerfile path, and `wrangler
deploy` builds that image with the Docker CLI before it uploads anything. The `deploy` job ran in
`container: node:22-alpine`, which has neither the CLI nor a daemon, so the first `v*` tag after
cf#798 would have failed at "Deploy core worker" -- whatever that tag was cut for, and with the
module workers already live and the core not.

Nothing could see it. `bundle-gate` passes `--containers-rollout=none`, which is exactly the flag
that skips the image build, so every gate stayed green and the defect was reachable only by pushing
a tag. Measured on the same tree, one flag apart: `--dry-run --containers-rollout=none` exits 0 and
names the container app; `--dry-run` alone exits 1 with *"The Docker CLI is needed to build the
configured image before deploying (even in dry-run mode)"*.

The job now runs natively on `ubuntu-latest`, which ships Docker, with Node from `setup-node` rather
than from the image, and it asserts the Docker CLI and daemon are reachable BEFORE it deploys
anything rather than discovering it midway. `timeout-minutes` goes 15 -> 30 because the ffmpeg image
build is now part of this job. The four runtime `apk` installs are replaced by presence assertions
that fail loudly: `envsubst` and `curl` come from the runner image, and a missing one must stop the
post-deploy gate self-check rather than let it be skipped.

`studio-release.yml` gets `--containers-rollout=none` on its bundle-only dry run, the same flag and
the same reason as `bundle-gate`. That step wants the JS and the flag does not change a byte of it;
without it, every tag builds the whole ffmpeg image just to emit a bundle, and a Dockerfile defect
would block the release of code that does not contain it.
