### fix(film): a retry before any clip does not count twice against the ceiling

A part that failed before its clips, then retried, counted a whole second estimate, so a ceiling near one part's estimate stopped the film with nothing spent on clips. The first 2 such retries per part now add nothing: the stills are kept, and one estimate covers them. From the third they count in full, so a loop reaches the ceiling. "Before its clips" is the part's film saying it holds no clip job. A film that cannot be read this tick is no longer read as gone, and is left for the next tick.
