### fix(docs): correct 7 stale denominators in module-readiness-coverage.md, and gate them (cf#829)

The page exists so that a reader who quotes a readiness result quotes the right denominator, and it
records having got that number wrong twice already. It was wrong a third time, in seven places, and
it contradicted its own table: the bullet naming the modules a tenant provision does not reach
named four modules the catalog DOES provision and omitted five it does not.

The table body was gated row for row; the prose around it was not. `expect(doc).toContain("17 of
34")` covered exactly one number, and the row-for-row check only reads lines whose first cell is a
module name, so neither instrument could see the population table, the `/ready` sentence or the
bullet. The suite was green with all seven values wrong.

Corrected, and the prose is now derived rather than typed: population sizes are parsed by
population number and compared to the measured tree, the `/ready` count is asserted against the
anchored matcher, and the not-provisioned bullet is asserted as a SET DIFFERENCE. The new gate was
driven red on all five defect shapes (each of the four population sizes, the `/ready` count, a name
added to the bullet, a name dropped from it) before being trusted.
