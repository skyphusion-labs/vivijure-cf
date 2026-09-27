### docs(video-finish): stop quoting a reject ceiling as an expected payload, and correct the finalize peak-disk claim (cf#813)

Comment and docstring only. **The executable AST with docstrings stripped is byte-identical**, so
there is no behaviour change in this PR at all.

**`MAX_CLIPS x MAX_CLIP_BYTES` is not a payload, in three places that said it was**
(`app.py:49-50`, `app.py:184`, `README.md:69`). That product is 20.0 GB and was presented as the
route's "contracted maximum", i.e. an input size to design against. `MAX_CLIP_BYTES` is a **reject
ceiling** -- the argument to `_download(s, url, dst, MAX_CLIP_BYTES)` at `:285` and `:416`, the size
at which a download is REFUSED -- so the product is the largest input the route will not reject, not
one it expects.

At this container's settings a 256 MB clip is 3.2 to 15.6 minutes of video; clips are 4 to 8
seconds. Measured, a 32-clip film normalizes to roughly 70-350 MB and a full 80-clip film to about
750 MB, so the product sits **23x to 120x above a real film** and nothing approaches the 20 GB
ephemeral disk. That is the part worth fixing rather than tidying: **a disk gate written against
20 GB could never fire.** The README now sizes the route by bitrate x duration x count with the
measured bands, and carries the proxy provenance and its direction of error, because those numbers
came from pans over a photographic still rather than from real generated clips.

**The 3x peak-disk multiplier is a budget, not a measurement**, and is now labelled as one. It is
only right if a normalized copy is about the size of its source; the measured ratio spans 0.98x to
5.09x and is dominated by the source's own bitrate. One component of it WAS structural, the fixed
1920x1080 upscale worth about 1.95x on a 720p source, and `vivijure-core#322` removes that at its
cause by matching the assemble target to the measured source.

**Peak disk at finalize is TWO full-length copies, not one.** `_silent.mp4` is written at `:315`
(chunked) and `:864` (single-pass), `_mux_bed_onto` (`:780`) writes `final.mp4` FROM it, and nothing
deletes the silent cut: `grep -n "os.remove" app.py` returns exactly `:266` and `:270`, both reaping
batch partials. **Those two hits are the positive control that the zero for `_silent.mp4` is a real
zero rather than a broken pattern.** `_remux_audio_only` (`:650`) has the same shape.

Not a correctness bug today: a real film measures in the hundreds of MB against a 20 GB disk.

**The removal of `_silent.mp4` is deliberately DEFERRED, and this inverts the usual rule.** Normally
the fix is the code, not a comment corrected to match it. It is held because this container is being
repaired and re-deployed right now, and an unrelated allocation change does not belong in front of
the first confirmed-serving build. The comment is corrected **now** because a wrong comment in this
directory has already cost a live debugging effort real time. The deferral and its reason are stated
at the site, so whoever lands the removal finds the argument rather than re-deriving it.
