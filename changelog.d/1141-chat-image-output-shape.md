**Fix: chat image reads the output shape the proxied models publish (#1141).**

`image-generate` read `url`, `image_url`, `output_url`, `data`, `images` and `output`, and the models publish `image`, sometimes wrapped in `result`. Every Google call answered `no image URL`. It now reads what `cloud-keyframe` and `cast-image` already read.
