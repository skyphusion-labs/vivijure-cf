### fix(panel): read film_finish, so a film that shipped without its title cards stops looking complete

`vivijure-core` has been projecting `film_finish` onto the render payload and nothing in `public/`
read it, so title-card and caption degrades were outside every band on every row. This is the
unfinished half of cf#549, which was filed about exactly that case.

Unlike cf#853 this takes effect **immediately**: the field is already on the installed core, on both
the single-film and the scatter path.

**The same three-state ladder in a different shape.** Core emits
`{ applied, adopted, degraded: string | null }`, and the whole object is `null` when the chain was
never reached:

    null / absent      the chain was never reached        -> unmeasured
    degraded: null     it ran and applied cleanly         -> none-reported
    degraded: "..."    it ran and SHIPPED UNCARDED        -> reported

So this is an **adapter into the generic path**, not a fourth parser: one normalising function plus
one entry in the stage list, and both panel surfaces pick it up through the machinery cf#853 landed
with no new rendering code.

**Strict on the degrade, forgiving on the ledgers.** An object with no `degraded` key at all reads as
`unreadable`, not clean: core always emits that key, so its absence is a shape we do not recognise,
and reading an unrecognised shape as "ran clean" is the one direction this projection must never fail
in. A malformed `applied` / `adopted` does NOT decide the band, because the band is a statement about
the degrade and nothing else.

**`adopted` is carried, and cannot light a badge (fc#1662).** It counts the recovered re-encodes,
steps whose artifact was found in R2 rather than run. That is the wasted-work signal and it is real,
but it is not a degrade: a film that reused every step and applied its cards cleanly is not a limited
film. It rides on the parsed info so a later surface can show it without re-deriving it, with a test
whose job is to fail if it ever starts lighting the badge.
