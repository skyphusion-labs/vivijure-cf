### feat(r2): support temporary R2 S3 credentials

The studio presigner and the `cf-grok-video` upload presigner read an optional `R2_S3_SESSION_TOKEN`. When set, presigned URLs sign `X-Amz-Security-Token`, so the R2 S3 pair can be an R2 temporary credential. When unset, URLs are byte-identical to before. The token is stripped from tenant and dispatch env with the rest of the credential (vivijure-cf#1232).
