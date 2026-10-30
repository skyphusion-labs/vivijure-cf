### fix(preflight): a shot is checked against the door the caller named (cf#926)

Preflight now reads the named door's `usage`. A shot over `max_seconds` is an error. A
shot under `min_seconds` or between `duration_steps` is a warning. A door that is not
installed is an error, where it used to pass with `ok: true`. `motion_backend` is read
as well as `motionBackend`, because the snake_case key was dropped with no word.
