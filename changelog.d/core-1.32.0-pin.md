### chore(deps): core 1.32.0 from npm

The studio now pins `@skyphusion-labs/vivijure-core` `^1.32.0` from the registry, replacing 1.31.0. Core 1.32.0 renews the film advance lease while a tick runs, with a 60 s lease in place of 300 s, so a film whose poll is cut off is free again within a minute. The cron sweep now also drives a keyframes-only film that nobody polls, and such a film still sends no email (vivijure-cf#1139).
