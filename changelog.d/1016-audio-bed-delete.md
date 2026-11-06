### feat(audio): an uploaded audio bed can be deleted

`DELETE /api/storyboard/audio-upload/:name` deletes an uploaded music bed. It accepts only a name the upload route mints (`<uuid>.<ext>` under `audio/`), so it cannot delete anything else; a missing file is a 404, and while a film render that has not finished selects the bed it answers 409 and names those renders. A finished render keeps its sound. The planner shows a "delete file" button beside an attached uploaded bed. PRIVACY Section 7 no longer says the studio has no delete action for an uploaded bed (vivijure-cf#1016).
