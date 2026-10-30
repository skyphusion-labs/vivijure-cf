### fix(modules): cf-veo sends the keyframe as base64

The model's schema takes `image_input` as a base64 image, and the door sent a presigned URL. Every render failed in seconds with `AiGatewayError: 2002: Error`. The door now reads the keyframe and sends a data URI.
