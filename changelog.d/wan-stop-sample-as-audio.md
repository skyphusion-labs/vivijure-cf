### fix(motion): stop sending Cast sample as Wan audio

Wan 2.6 wants the shot line wav on `input.audio`. The Cast sample is a
different object (Seedance `reference_video`). Sending the sample made
mouths follow the preview, not this shot's line. Until the line file
ships, Wan invents speech from the prompt and does not lock the sample
you kept.
