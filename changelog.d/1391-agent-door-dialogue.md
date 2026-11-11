### Feat: the agent door and long films can pick the dialogue module (#1391)

`POST /api/render/film` (vivijure-mcp `submit_film`, Slate, and every part of a long film) now takes `dialogue_backend` and `dialogue_config`, as the panel door has since #1379. Before this, a caller there always got the first dialogue module by ui.order.

- The name must be an installed module that serves `dialogue`. Each `dialogue_config` key must name one, and its map is judged against that module's schema and then clamped. A refusal is `400`, by name, before anything is spent.
- `POST /api/film` takes both in `shared` and sends them to every part, so the parts speak with one dialogue module. A module this studio does not serve is refused before the film is stored.
- With no choice nothing changes.
- vivijure-mcp `submit_film` still has to expose the two fields (separate repo).
