### fix(finish-upscale): the default is the delivery height, not a factor (vivijure-core#389)

The schema default of `scale: 2` was filled into every config, so every upscale counted as an explicit 2x and the delivery-height route never ran. The default is now `0`, shown as "to delivery height". An explicit 2x or 4x still wins. A clip already at the target calls no door. The module declares `finish_scales_frame`, so a core from 1.28.2 prices the film at that frame before it spends.
