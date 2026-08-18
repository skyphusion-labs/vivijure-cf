### feat(motion): send Alibaba media[] on Wan 2.7

CF is a passthrough to Alibaba. We now send first_frame, last_frame,
and driving_audio (Cast sample) plus the CF image postcard. Without
driving_audio Alibaba invents speech. This is the prove-it rewrite.
