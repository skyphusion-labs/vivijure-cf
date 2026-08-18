### fix(finish): RIFE keeps the clip key and does not kill the film

Own-iron finish_clip needs clip_key. Core used to strip it after
presign; RIFE then fail-closed a completed 10-shot. Recover the key
from video_url if it is gone, forward both to RunPod, and only refuse
when there is no clip at all.
