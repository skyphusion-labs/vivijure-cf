### Upload reads, beat analysis, route parameters, and provider media

Upload routes check `Content-Length` before reading, and stop the stream at the cap. That covers `/api/upload`, `/api/storyboard/character-ref`, `/api/storyboard/audio-upload`, cast raw-byte portrait, ref and source adds, and voice-sample attach. An over-cap body is `413`.

`POST /api/audio/analyze` accepts an `audioKey` only when it is in served artifact space, the same prefixes `/api/artifact` uses. The `<audioKey>.beats.json` marker is written only for such a key.

A route parameter that is not a valid percent-encoding returns `400` with the usual response headers.

A provider media URL is read up to a cap. The stored content type is a sniffed or allowlisted media type. A type outside that list is not stored.
