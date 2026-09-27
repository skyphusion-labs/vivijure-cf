### fix(containers): stream the audio-master and audio-mix uploads instead of reading them into RAM (cf#814)

`audio-master` and `audio-mix` each did `out_bytes = f.read()` and then `data=out_bytes`, so the whole
produced artifact was materialised in memory before the PUT began. Both now stream from a file handle
through a vendored `_put_file` helper, the same fix #808 applied to `video-finish`.

**Why it matters most in `audio-master`.** Its output `format` defaults to **`wav`**, not mp3, and the
source bed is bounded only by `MAX_BED_BYTES` (256 MB), which makes it the largest buffer of the CPU
set. `audio-mix` accepts `wav` too, and a film-length stereo WAV runs about 10 MB per minute.

**`Content-Length` is set explicitly, and that is the part that is easy to get wrong.** aiohttp falls
back to chunked transfer-encoding for a file object with no length, and a presigned PUT will not accept
chunked -- streaming without the header trades an OOM for a 4xx. The behavioural half of each new test
asserts the header, so a future refactor cannot drop it silently.

The helper is **vendored per directory**, matching how `url_guard.py` already lives in each container.
No shared import path is introduced across `containers/`; each image builds from its own directory.

**The wire contract is unchanged.** A non-2xx PUT still answers 502 with the exact string `output put
<status>`; it now travels as a `_PutFailed` the route catches rather than an inline early return. The
reported `bytes` is the real file size from `os.path.getsize`, not the length of a buffer that no
longer exists.

**The control is carried across with the fix, which is the point.** Each container gets its own
`test_upload_streams.py`, registered in the `container-tests` CI list (the executed-script floor moves
14 -> 16). Each pairs a behavioural check, driving the real `_put_file` against a fake session and
inspecting what reaches `session.put`, with an **`ast`-based structural scan** that refuses the
read-then-upload shape anywhere in `app.py`. Parsed, not grepped, deliberately: a line-regex version of
this scan was measured blind to a handle named anything other than `f` and to a `guarded_put(` whose
`data=` sat on a continuation line, and both are ordinary hand-written formatting. Each scan carries
its own planted-violation positive control, so it cannot pass vacuously.

That half is not decoration. This shape reached four sites in `video-finish` by being copied from a
neighbouring route, and it reached both audio containers the same way -- `audio-master/app.py` says in
its own docstring that it is "Modeled on `containers/audio-mix/app.py`", and that file says it is
modeled on `video-finish`. A fix without the scan is one copy-paste from being undone.

**`image-prep` is documented, not changed.** Its bytes are produced in memory by rembg and never
written to disk, so streaming there needs a spill-to-disk first; that is a redesign, not a call-site
swap, and bundling it here would have hidden it. Its README now carries a written note on why the
buffer is acceptable (bounded by `MAX_INPUT_BYTES`, 32 MB, one portrait, not a function of film
length), and states the residual it does NOT cover: that bound is on compressed bytes, so a small,
highly compressed image still decodes large.

No behaviour change for callers, no new runtime dependency.
