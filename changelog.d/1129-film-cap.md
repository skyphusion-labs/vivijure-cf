### fix(finish): title cards, captions, mux and frames take a film over 256 MB (#1129)

These routes capped the whole film at the 256 MB clip limit, so a film past a few minutes lost its cards and captions. They now use the size assemble admits, 6.85 GB. Film transfers are bounded at 30 minutes with a stall check, not 120 s, and a whole-film encode at three times the film's length, never below 20 minutes. Title cards remove the source once it is normalized, so peak disk is two copies of the film, about 16 GB at the cap against the 20 GB disk.
