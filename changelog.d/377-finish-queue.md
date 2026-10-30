### feat(finish): films queue for a finish slot in order, and a missing step is never a clean finish

Films now take finish slots first come, first served, and a poll shows "waiting, position 3". A transient failure in any finish step holds the film; a permanent one, or a wait that runs out, leaves the film `done` with `finish_incomplete`, which the panel shows as a warning with a retry that re-renders no clip. Adds migration 0023. Requires a core release with `finish-queue`.
