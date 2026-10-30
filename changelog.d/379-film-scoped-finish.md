**Fix: support film-scoped finish clips (vivijure-core#379).**

`finish-blender` writes to the `output_key` core sends. Deleting a render now frees its folder at `renders/<project>/clips/<film_id>/`, including intermediate clips that no record names.
