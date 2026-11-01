### fix(retry): a retry repeats the original film, or does not start (#1177)

The film and render doors store the request beside the film, and retry replays it with `reuse_finished`, so cast, voices, bed and titles are kept and proven work is not bought again. A render with no stored request now answers 409 saying what it would lose, unless `accept_rederive: true`.
