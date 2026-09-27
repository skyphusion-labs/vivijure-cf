### fix(retry): reach the real parent preview, and declare a lossy retry (cf#805)

Finalize retry passed the FAILED row as its own `parent`, and
`validatePreviewParent` requires a COMPLETED keyframes-only preview, so every
finalize retry 400ed. The row already records `parent_id`, so retry now loads
that preview and the finalize precondition stays intact rather than weakened;
a missing or deleted parent refuses honestly instead of rebuilding a full film.
A full retry cannot be a replay -- `renders` persists none of the submit-time
inputs -- so it now DECLARES the degrade (`degraded`, naming the dropped fields)
rather than answering a bare 201 on a different film.
