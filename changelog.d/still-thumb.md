### feat(studio): a small copy of a still for contact sheets

`GET /api/thumb/*key` returns a still at 360 px wide as JPEG, through the Images binding, with the same auth and key rules as `/api/artifact`. A contact sheet of 40 no longer needs 40 full PNGs. If the original cannot be resized it answers 502 with the path of the original, and 503 if `IMAGES` is not bound. It never returns a blank image. A deployment needs the `[images]` binding.
