### fix(finish): a finished job gives its instance back sooner

A finish container now sleeps 5 minutes after core reads a terminal status, in place of 10. While a job can still be running the timer stays at 10 minutes. This doubles the rate at which short films can start, and halves the idle bill per film.
