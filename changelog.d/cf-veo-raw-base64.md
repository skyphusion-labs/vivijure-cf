### fix(modules): cf-veo sends bare base64

The provider rejected the data URI with "Invalid base64 encoded bytes", so `image_input` is now the base64 of the keyframe with no prefix.
