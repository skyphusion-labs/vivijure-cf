### docs(video-finish): the plane writes the tier-state var (cf#871)

The comment said nothing sets `VIDEO_FINISH_TIER_STATE`. The control plane
projects it on provision, studio upgrade, and the admin route. That sentence
is removed. Precedence is unchanged: a live door or a non-empty URL is
available, and the label applies only when both are absent.
