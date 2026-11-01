### fix(dialogue-gen): bring each spoken line to one level

Aura's level varied by about 15 dB from line to line, and short lines came back quietest, so one speaker could be hard to hear. Each line now goes to -20 dBFS of speech, measured with pauses left out, up to a -1 dBFS peak and at most 24 dB of gain. Measured on 40 real lines: speech level range 15.3 dB before, 2.1 dB after. It applies to lines made after this deploy. A line that is reused keeps its old level.
