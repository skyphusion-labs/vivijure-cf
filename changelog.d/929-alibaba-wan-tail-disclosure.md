### docs(alibaba-wan): disclose that the mouth keeps moving after the line ends (cf#929)

Wan 2.6 keeps the speaker articulating once the driving line stops. The vendor doing that is the
vendor's business; what was ours is that **nothing we published let a user predict it**. The blurb
stopped at "Mouth follows the storyboard line", which reads as a promise that it tracks the line;
`ui.limits` never mentioned the tail; and `duration_steps: [5, 10, 15]` read as a menu when it is a
floor plus a rounding rule.

Measured against an `infinitetalk` control on the identical keyframe and the identical Cast track, so
only the door differed. A **1.4s line in a 5s clip**:

| | InfiniteTalk | Wan 2.6 |
|---|---|---|
| mouth motion, speaking | 7.724 | 3.256 |
| mouth motion, silence | **0.744** | **3.787** |
| speech -> silence | **10.4x quieter** | **1.16x LOUDER** |
| mouth/audio correlation, whole clip | +0.693 | **+0.066** |

Read the within-clip change rather than the absolute means: frame-to-frame pixel delta shrinks as fps
rises and these clips are 25fps vs 30fps, so only the speech-to-silence ratio is comparable across
doors. Wan's whole-clip correlation of **+0.066** is the summary -- across the clip there is no
relationship between mouth motion and the audio. **72% of that clip is the speaker mouthing nothing.**

Not an audio-provenance problem: the output audio is our Cast track at raw-sample `r=+0.9996` at zero
lag, with `infinitetalk` as a known-good control at `r=+0.9997`. Wan took the driving path, used our
track, and carried on past it.

`clampDuration` snaps **up** to the next of `{5, 10, 15}`, so a line shorter than 5s cannot produce a
clip shorter than 5s. Ordinary dialogue is shorter than 5s, which makes the tail the normal case rather
than an edge case.

Disclosure only -- no behaviour change. The blurb now says the mouth keeps moving after the line ends,
two `limits` entries name the tail and the short-line case that guarantees it, the duration limit says a
shorter shot is rounded up, and a comment on `duration_steps` records the floor-plus-rounding reading.
Module `0.2.0` -> `0.2.1`.

A machine-readable `usage` flag for the property is deliberately **not** added: it shares a contract
surface with the `length_follows_audio` question and should not land twice in different shapes.
