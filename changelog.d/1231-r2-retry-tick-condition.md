### test(r2-retry): the advanceFilmJob tick waits on its condition, not on a pass count

The "through real core advanceFilmJob" tick helper gave up after 600 fake-clock passes, so on a loaded machine the loop could run out before `advanceFilmJob` settled (cf#1231). It now loops until the tick settles, bounded by 30 s of REAL wall time captured before the clock is faked, and yields a real macrotask each pass so work the fake clock does not control can progress. What the tests assert is unchanged.
