### feat(keyframe): a two-person portrait strength for the scene pass

The `keyframe` module has a `plate_ip_adapter_scale` setting (0 to 1, default 0, off). On a two-person shot it sets how strongly the first (scene) pass takes each person's cast portrait in their own half of the frame, so a two-shot can keep each person's hair (cf#1143, vivijure-backend#578). Older backend images ignore it.
