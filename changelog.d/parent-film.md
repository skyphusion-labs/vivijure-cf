### feat(film): long films as parts under one parent

`POST /api/film` takes a master board, splits it into ordinary film jobs, runs them in order with limits, and joins the finished films. `GET /api/film/:id` reads it. `POST /api/film/:id/parts/:n/retry` re-submits a failed part and keeps proven work. `POST /api/film/:id/ceiling` raises the spend ceiling. The ceiling counts retries. `POST /api/render/film` now takes `delivery_width` and `delivery_height`.
