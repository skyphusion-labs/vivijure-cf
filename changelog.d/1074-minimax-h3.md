### feat(modules): add a minimax h3 door (cf#1074)

Silent clips on Cloudflare AI Gateway (`minimax/h3`). 4 to 15 seconds.
768P is $0.08/s and 2K is $0.13/s. The schema states no resolution default
and no native audio output, so the door stays silent and sends 768P unless
you choose 2K. The door is installable and is not a spoken or silent default.
