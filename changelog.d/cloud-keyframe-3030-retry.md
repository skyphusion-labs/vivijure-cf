### fix(cloud-keyframe): retry a flaky FLUX 3030, then fail honest

Same "Your output has been flagged" that cast-image already detects.
Cloud keyframe now retries the shot up to 3 times (same prompt, then a
light cinematic rephrase). A persistent 3030 still hard-fails. CSAM
refusals are not retried. Module 0.1.2.
