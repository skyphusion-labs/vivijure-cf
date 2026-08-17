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
Provider safety filters default OFF (they eat legitimate test films).
Seedance always sends use_virtual_avatar (stills are synthetic, not photos).
CF Seedance default is 2.5 (up to 30s). Grok default is Imagine Video 1.5.
Stills catalog adds Seedream 5 Pro, Grok Imagine Image, Imagen 4, Nano Banana 2.
New hosted doors: InfiniteTalk, Chatterbox, Kling O1 R2V, CF Wan 2.7, CF Hailuo 2.3, CF Veo 3.1.
Hosted wrangler no longer binds Kling 2.1 or Wan 2.6. Code stays in modules/.
