### Fix: a long film's default frame rate reads finish-rife's declaration (#879)

`parentDefaultDeliveryFps` now passes each finish step's `finish_artifacts` to core's `predictDeliveryFps`, so the rate comes from finish-rife's declared `rate_factor`. vivijure-core#543 removes the binding-name fallback; without this, a long film with RIFE in its chain would default to 24 fps on that core. The pinned core (1.45.0) already reads the field. The finish-rife rate test now holds the declaration against a copy of the old binding rule rather than against core's removed fallback.
