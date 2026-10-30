**Fix: a cancelled film can stop a running GPU finish step (#1109).**

`finish-rife`, `finish-upscale` and `finish-blender` now implement `POST /cancel` and set `cancelable: true`. It needs a vivijure-core with vivijure-core#378 to be called.

`film-titles` and `subtitle` stay uncancelable, because the video-finish container has no cancel route. `audio-master` returns synchronously, so it has no running job to stop.
