### ci: gate the container deploy SHAPE, which bundle-gate structurally cannot see (cf#809)

`bundle-gate` passes `--containers-rollout=none` so it stays Docker-free, credential-free and fast on
every PR. That flag SKIPS the container image build. So it answers "does the worker bundle", and it
was read as answering "does the deploy work" -- which is how cf#798 merged green while arming a
deploy failure only a `v*` tag could reach. A gate that passes by not performing the step it covers
is the failure mode.

`container-deploy-shape` runs the real thing: `wrangler deploy --dry-run` with NO rollout flag, so
wrangler builds `containers/video-finish/Dockerfile` for real. `--dry-run` keeps it credential-free
and fork-safe; nothing contacts the account and nothing is pushed.

Path-filtered, and NARROWER than `container-pr-build.yml` on purpose: this asks whether the deploy
shape still assembles, which moves when the wrangler config or the Dockerfile wrangler is pointed at
moves -- not when a pin changes in `requirements.txt`, which `container-pr-build.yml` already owns.
That keeps an ffmpeg build off unrelated PRs and stops the same image being built twice for a change
only one gate is about. The set of Dockerfiles is READ from the `[[containers]]` image lines rather
than hand-listed, and an empty parse is a hard failure, so adding a second container cannot leave
this gate silently watching only the first.

Two jobs (detect, then gate) rather than one that exits 0 when not applicable: a not-applicable run
must render as SKIPPED, never as a green tick.
