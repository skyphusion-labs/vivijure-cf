### feat(motion): a spoken shot is the cast line on InfiniteTalk (cf#983)

The hosted default for a board with a line is InfiniteTalk when that driving-only
door is installed. own-gpu and alibaba-wan are not that default. A kept Cast
sample does not switch the default to Seedance. `generate_audio` stays off when
the module declares it, and the voice-sample clip is not sent. A board with no
line uses one silent catalog door. The clip is the shot still. The ten cast
training refs are not attached.
