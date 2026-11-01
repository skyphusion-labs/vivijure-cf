### fix(history): keep unchanged rows, load no film until expanded, send ETags

The film list keeps a row's element when the row has not changed, so a refresh no longer stops a playing video. A collapsed row loads no film. The render clock uses the server's run time on a second device. Artifacts send an ETag, answer `If-None-Match` and honour `If-Range`.
