### fix(modules): cf-minimax-h3 reads the wrapped response

The gateway returns `{ state, result: { task } }`, and the door read `task` from the top. Every clip was generated and billed, then thrown away with "model completed but returned no video URL", and the workflow retried it twice more. The door now reads both shapes.
