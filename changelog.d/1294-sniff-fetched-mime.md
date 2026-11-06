### fix(image-generate): a fetched proxied image is stored with its real type

A proxied model that answers with a URL had its mime taken from the fetched `content-type` header. A Recraft V4 chat image was a WebP stored as `image/png` under a `.png` key. The module now sniffs the fetched bytes and keeps the header only when the magic bytes are not a known image type. `sniffImageMime` also knows GIF now, so it agrees with `hasImageMagic`. `image-generate` is 0.1.3.
