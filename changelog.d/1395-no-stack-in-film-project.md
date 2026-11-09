### Fix: a failed board save answers fixed text, and the error goes to the log (#1395)

CodeQL alert #86 (`js/stack-trace-exposure`): `saveFilmProject` returned `e instanceof Error ? e.message : String(e)` as the project `error`, and `POST /api/film` put it in its response. A thrown value can carry a stack or storage internals. Now any failure that is not a refusal the caller can act on is logged (`film_project.save_failed`) and answered with a fixed sentence: the board could not be saved to a project, and the film still started. The bundle board read (`film_project.bundle_board_read_failed`) works the same way. Core's `BoardKeyCollisionError` is still reported in core's words, because it tells the caller to retitle the board.

**For a client.** On a failed save, `project.error` is now one of two fixed sentences instead of the underlying error text.
