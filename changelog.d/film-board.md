### feat(films): a film board for long films built as parts

New `/films` page, phone first. It shows a parent film's phase, shots, estimate, stop reason and limits, each part's status and error, retries a failed part, resumes a held film or a failed join, raises the spend ceiling, and offers the joined film and each part to watch or download. It projects `GET /api/film/:id`, so it needs the parent film routes. Actual spend is not shown as a number because no meter attributes it to one film. `test:browser` now also covers this page and runs in CI.
