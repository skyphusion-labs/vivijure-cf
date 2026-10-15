### fix(video-finish): an unprovisionable tier overrides a set URL (cf#871)

`videoFinishState` returned `available` for any non-empty `VIDEO_FINISH_URL` before it read
`VIDEO_FINISH_TIER_STATE`, so a plane declaration of `unprovisionable` could not reach the panel
while that URL was set. A live door still wins first. The tier state is consulted next, and only
then a non-empty URL.

The control plane projects the var onto the studio. The comment that said nothing sets it was
the stale one and is gone. The comment that names that writer stays.
