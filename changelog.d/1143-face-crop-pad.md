### feat(keyframe): a face reference margin for the scene-lock pass

The `keyframe` module has a `face_crop_pad` setting (0 to 2, default 0.35, the crop shipped before). It sets how much around each face the scene-lock pass takes from the cast portrait, so a two-person still can keep each person's hair (cf#1143, vivijure-backend#576). Older backend images ignore it.
