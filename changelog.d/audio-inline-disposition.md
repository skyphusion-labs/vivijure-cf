### fix(planner): audio artifacts serve inline so the player shows duration

`/api/artifact` used Content-Disposition: attachment on every object.
Chrome's audio control then stayed at 00:00 / 00:00. Image, video, and
audio now serve inline. Other types stay attachment.
