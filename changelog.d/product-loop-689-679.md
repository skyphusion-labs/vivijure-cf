MusicGen player loads the bed as a blob so duration is real (#689).
Motion cards are filmmaker copy, not Unified Billing (#679). Full door
blurbs + docs/motion-door-limits.md are the honest limits reference
(duration, talks?, how the voice stays the same, scatter).
AV doors stamp has_audio. Voice lock + look lock prepend to every motion
prompt so Flux/Seedance keep the same speaker. Cast auto-fills the lock
(name + Aura timbre). Empty lock blocks native-audio motion submit.
Talking clips never scatter. own-gpu, local-gpu, wan-lora, and HappyHorse
refs stay on one film too (look / face lock). Only silent generic cloud
(Kling, Hailuo, Wan without a face) may still split.
