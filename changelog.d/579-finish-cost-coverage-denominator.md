### feat(planner): count the finish-cost silence, N of M installed modules (cf#579)

The cf#540 guard admits when no module declares a finish cost, which stays the right
call. This adds the forcing function it lacked: a registry-derived census,
`finishCostCoverage`, reported as `declared by N of M installed finish modules` with
machine-readable `data-finish-cost-*` attributes on the preflight panel. The aggregate
carries the same three-way split as the per-render path: a registry that could not be
read reports NULL, never 0 and never 0 of M.
