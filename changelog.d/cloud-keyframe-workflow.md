### fix(cloud-keyframe): draw keyframes in a Workflow

`cloud-keyframe` draws one shot per Workflow step. Progress no longer depends on a poll, and `/poll` returns from one R2 read, so a poll does not hold the film advance lease for the length of a draw. `/cancel` stops the Workflow, and the Workflow stops by itself when its film is over. A re-submit for the same film and shots reaches the run already going. A host without the new `KEYFRAME_WORKFLOW` binding draws one shot per poll, and a poll token from before the change finishes that way.
