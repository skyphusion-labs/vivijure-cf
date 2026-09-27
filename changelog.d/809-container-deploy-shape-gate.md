### ci: build the container through wrangler on a PR, which bundle-gate structurally cannot (cf#809)

`bundle-gate` passes `--containers-rollout=none` so it stays Docker-free, credential-free and fast on
every PR. That flag SKIPS the container image build. So it answers "does the worker bundle", and it
was read as answering "does the deploy work" -- which is how cf#798 merged green while arming a
deploy failure only a `v*` tag could reach. A gate that passes by not performing the step it covers
is the failure mode.

**Corrected after measuring it.** The first draft of this gate omitted the rollout flag from
`wrangler deploy --dry-run`, on the theory that omitting it performs the build. It does not: that job
went green in 40 seconds with no build in its log. What wrangler does in dry-run is CHECK that the
Docker CLI can be launched, and the local failure that started cf#809 was that launch check failing,
not a build failing. On a runner that has Docker, the check passes and nothing is built. Shipping
that as "the real build runs" would have been decoration.

So the build is explicit: `wrangler containers build <dir> --tag <name>`, which executes the real
Dockerfile through wrangler's own container path with `--push` defaulting to false. The
`video-finish` image's three ffmpeg sanity encodes (libx264, drawtext, libass) are ordinary `RUN`
layers and therefore execute, so the build is the assertion. Credential-free and fork-safe: nothing
contacts the account and nothing is pushed.

Path-filtered, and NARROWER than `container-pr-build.yml` on purpose: this asks whether the deploy
shape still assembles, which moves when the wrangler config or the Dockerfile wrangler is pointed at
moves -- not when a pin changes in `requirements.txt`, which `container-pr-build.yml` already owns.
Both the detection set and the build set are READ from the `[[containers]]` image lines rather than
hand-listed, and an empty parse is a hard failure, so adding a second container cannot leave this
gate silently watching only the first.

Two jobs (detect, then gate) rather than one that exits 0 when not applicable: a not-applicable run
must render as SKIPPED, never as a green tick.
