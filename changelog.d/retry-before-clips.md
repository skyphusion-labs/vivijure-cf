### fix(film): a retry before any clip does not count twice against the ceiling

A part that failed before its clips, then retried, counted a whole second estimate, so a ceiling near one part's estimate stopped the film with nothing spent on clips. Such a retry now adds nothing: its stills are kept, and one estimate covers them. It is still an estimate. GPU time lost to the failed run, such as a cold model pull, is not counted.
