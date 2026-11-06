### feat(cloud-keyframe): a shot with no place is drawn in the board's setting

cloud-keyframe reads the storyboard's optional `setting` (vivijure-core#435) from `storyboard.yaml` and says it after any shot whose prompt and style prefix do not already contain it (`Setting: <setting>.`), in the plate and the final pass. A board with no setting draws exactly as before. `docs/CONTRACT.md` A.4 documents the field and how both keyframe doors use it. Refs cf#1145.
