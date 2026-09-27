### ci: gate the container build on a PR, and prove the gate actually built (cf#809)

`bundle-gate` passes `--containers-rollout=none` so it stays Docker-free, credential-free and fast on
every PR. That flag SKIPS the container image build. So it answers "does the worker bundle", and it
was read as answering "does the deploy work" -- which is how cf#798 merged green while arming a
deploy failure only a `v*` tag could reach. A gate that passes by not performing the step it covers
is the failure mode.

`container-deploy-shape` runs `wrangler deploy --dry-run` with the rollout flag OMITTED, which does
build the image. Measured on the runner rather than assumed: 1317 buildkit step lines, 394 apt-get
lines, and all three of the Dockerfile's ffmpeg sanity-encode markers (libx264, drawtext, libass).
`--dry-run` keeps it credential-free and fork-safe; nothing contacts the account and nothing is
pushed.

**The build is ASSERTED, not assumed.** A second step fails the job unless the log carries real
buildkit evidence. The entire premise of this gate is that a sibling passes by skipping the build, so
a future wrangler that stops building during `--dry-run` would silently turn this one into the same
decoration. Nothing in an exit code distinguishes "built it" from "skipped it", so the job is not
allowed to rely on one.

Path-filtered, and NARROWER than `container-pr-build.yml` on purpose: this asks whether the deploy
shape still assembles, which moves when the wrangler config or the Dockerfile wrangler is pointed at
moves -- not when a pin changes in `requirements.txt`, which `container-pr-build.yml` already owns.
The Dockerfile set is READ from the `[[containers]]` image lines rather than hand-listed, and an
empty parse is a hard failure, so adding a second container cannot leave this gate silently watching
only the first.

Two jobs (detect, then gate) rather than one that exits 0 when not applicable: a not-applicable run
must render as SKIPPED, never as a green tick.

Note for anyone reaching for it: `wrangler containers build --push=false` cannot serve as this gate.
It requires `CLOUDFLARE_API_TOKEN` even when it pushes nothing, and this gate must run on fork PRs
that have no secrets.
