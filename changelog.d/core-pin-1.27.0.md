### fix(core): move vivijure-core to 1.27.0

This jump passes over core 1.26.0, so a render can now fail where it used to report success. A concat that did not run fails the film and keeps the clips. A song that could not be read or attached fails the film and keeps the silent cut. A film with no song still finishes on its silent cut.

A failed film now gets `clip_urls` for its kept clips, and the panel says the clips are kept. A full finish tier is a wait once the door change lands. A lone unstamped clip is adopted only after 5 minutes.
