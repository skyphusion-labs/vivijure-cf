### Feat: the studio offers core a door for short-line shots (cf#930)

Conrad's ruling (2026-11-11): a per-shot motion door applies to that one clip only, and the film's door stays the default for every other shot.

Core 1.47.0 does the moving. Take a lined shot whose film door is driven by audio and priced by length, where that door's clip floor would leave the speaker mouthing words after the line: Wan 2.6 makes a 1.4 s line into a 5 s clip (cf#929). Core moves that one shot to the first door the studio offered that takes it without a tail. The panel shows the result as `door_fit`.

This repo builds the offer (`src/door-fit-offer.ts`). It lists the other serving driven motion doors with the film door's locality, in `ui.order`, each prepared as a spoken clip. It is sent from the main render, render-from-keyframes, the finalized animate path, render-retry and the agent film route. A door the caller set on a shot is never moved. A film door the caller named is still the default for every shot, and a short-line shot may move off it for that one clip (Conrad's ruling, 2026-11-11: `DOOR_FIT_FOR_EXPLICIT_FILM_DOOR` is true). Hybrid and cloud-per-shot renders set a door on every shot, so they are not offered one. Core moves to `^1.47.0`.
