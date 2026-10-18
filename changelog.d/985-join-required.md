### fix(film): a film is not done until it is joined

The poll reports a film failed when the join did not run, including when the published package still marks that job done. A song starts a film only after beat-sync has read it. The analyze route stores that read in R2, and the film start doors refuse a song with no read. A spoken line whose word-count estimate is longer than 12 seconds is refused at those same doors when a song is attached. The planner sets a spoken shot to that estimate when the line fits the beat window, and it reports the shot when the line does not fit. The upload hint says a full song is mp3 or m4a, the cap is 32 MB, and a stereo 44.1 kHz WAV of about three minutes fills the cap.

video-finish, audio-beat-sync, audio-mix, and audio-master run one image that contains ffmpeg and librosa. image-prep stays its own image. Compose selects the service with CPU_APP.

A song analyzed before this marker existed has no `<audioKey>.beats.json`. Those doors refuse it until the track is analyzed again.
