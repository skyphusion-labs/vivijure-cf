### ci(containers): start the image and make it SERVE, because BUILT was never the property we wanted (cf#857)

`container-deploy-shape` was built in cf#817/cf#818 and it proves an image was **built**.
`container-tests` runs the container's python scripts against the **repo checkout**. Neither one ever
starts the image. So the one property anybody wants from a container gate, does this boot and bind its
port, was unasserted, and the `v1.34.1` tag run (`36296493766`) went green on all ten jobs over an
image that crashes on every startup (cf#851: `Container crashed while checking for ports`, 12
occurrences in one tail session, assemble to failure in 3,211 ms). Built and runs are different
properties, and only the second one is the product.

**`scripts/container-smoke.sh`** starts an image, maps its port on loopback, and polls `/health`.
Distinct exit codes, because a control that accepts any non-zero cannot tell a working guard from one
broken in a new way: `2` instrument unavailable, `3` image will not run at all, `4` container exited
before serving (the cf#851 shape), `5` running but nothing bound, `6` bound but not 2xx. An exited
container is answered in milliseconds rather than after the full timeout, so a red here never trains
the reader to think "slow". It passes NO env, deliberately: the deployed `[[containers]]` block sets
none, so a boot that depends on an env var must fail here exactly as it does in production. Every
unavailable instrument is a FAILURE, never a skip, including a missing docker CLI, because a gate
whose cheapest satisfaction is not running the container is the same defect one level up.

**`tests/container-smoke.test.sh`** is the control, and cf#857 is precisely a gate that could not
fail, so it is not optional. It builds three fixtures and asserts the exact exit code AND the reason
text for each: one that serves (`0`, the POSITIVE control, without which "it went red on the broken
image" would not distinguish a working gate from one that always fails), one whose entry script
imports a module the image does not contain (`4`, the cf#851 shape planted in two lines), one that
stays up bound to a port nothing probes (`5`), plus a non-existent image ref (`3`, an instrument
failure is a failure). The fixtures are built in the test rather than committed as a directory so the
planted failure sits next to the assertion about it.

**It cites the artifact it judged.** Both the pass and the failure paths print the image id read off
the CONTAINER (`docker inspect --format '{{.Image}}'`), i.e. the bytes this run actually used, rather
than resolving the mutable tag a second time, plus RepoDigests where the image has been pushed and an
explicit `(none: locally built, never pushed)` where it has not, because an empty field reads like a
missing value. A verdict nobody can attach to a specific image cannot be checked later, and "the broken
one versus the fixed one" is the comparison this gate exists to make. The control asserts the citation
on every case where a container actually started, so the capability is proven rather than hoped for.

**`tests/container-image-file-set.test.py`** is the fast, docker-free half, and it is the gate that
would have caught cf#851 in the PR that caused it. For every `containers/*/Dockerfile` on disk (the
denominator read from the tree, never a hand-kept list) it walks the import graph from the entry
script named by `CMD`/`ENTRYPOINT` and fails if any reachable LOCAL sibling module is not `COPY`ed
into the image. Imports at any scope count: a function-scope import of a missing sibling fires on the
first request down that path instead of at boot, which is strictly worse to debug. It names the
missing file, which is the difference between a red gate and a red gate you can act on. Three controls
run first: a fully-copied image reports nothing (it does not cry wolf), a planted missing module is
reported, and a function-scope import two hops from the entry is still caught.

**The detect denominator was too narrow, and that is a second finding.** `container-deploy-shape-detect`
matched only the Dockerfile PATH, but a Dockerfile's build context is its DIRECTORY, so every file
copied into the image can change what the image contains without the Dockerfile appearing in the diff.
Proven against real history by running the SHIPPED detect text out of each `ci.yml` version against
`3802502` (#712, which touched `containers/video-finish/app.py`, `photometric_gate.py` and a test, and
no Dockerfile): the old text returns `needed=false`, so that PR ran NEITHER container gate; the new
text returns `needed=true` and names each context file. Negative control on a docs-and-modules commit
(`c7b5850`): still `false`, so the widening adds the context rather than selecting everything.

**And the release now waits for it.** `deploy` listed `container-tests` and `migrations-gate` but
nothing that starts the container, and `container-deploy-shape` is not in that array either, so a tag
could deploy with it RED and the deploy job would never look. `container-smoke` is added, with the
deadlock check that belongs on any `needs:` widening: it is the only member carrying an `if:`, and a
SKIPPED dependency skips the dependent job, which would silently turn a release into a no-op, so its
condition includes `startsWith(github.ref, 'refs/tags/v')` explicitly rather than trusting a shell
script's output two hops away. `container-deploy-shape` is deliberately not added: it proves a BUILD,
and the smoke job builds each image itself before starting it.
