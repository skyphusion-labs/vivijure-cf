**Fix: deleting a render frees its film-scoped finish clips (vivijure-core#379).**

Deleting a render now frees its folder at `renders/<project>/clips/<film_id>/`, including intermediate clips that no record names.
