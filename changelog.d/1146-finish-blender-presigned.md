**Fix: finish-blender sends the presigned URLs the core gives it (#1146).**

`finish-upscale` and `finish-rife` forward `video_url` and `output_url`, and `finish-blender` did not. So the door could only use R2 mode, and a door with no R2 env failed every shot and the whole film after the clips were paid.
