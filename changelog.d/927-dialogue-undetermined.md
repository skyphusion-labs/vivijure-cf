### fix(render): refuse when the bundle dialogue cannot be read (cf#927)

`render-from-keyframes` and the agent door read the bundle outside the dialogue guard. A bundle that is not gzip now returns 503 and does not start the film. A missing bundle is still "no scenes".
