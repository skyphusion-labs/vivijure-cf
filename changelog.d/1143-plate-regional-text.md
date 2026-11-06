### feat(keyframe): keep each person's look to themselves in a two-person still

The `keyframe` module has a `plate_regional_text` setting (default off). On a two-person shot it gives each person's description only to their own half of the first (scene) pass, while the scene, the style, the setting and the adult statement stay for the whole frame, so one person's clothes do not land on the other (cf#1143, vivijure-backend#580). Older backend images ignore it.
