### docs(cast): flip-safe character design for cloud keyframes

The cast editor, the studio guide and the `cloud-keyframe` README now say that a one-sided mark is not reliable on the cloud route. Use marks that read the same when mirrored, and make them bold, because a thin mark can drop out. This removes the wrong-side failure. It does not promise drift-free output.
