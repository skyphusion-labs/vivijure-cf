// Constants for how a film run treats its film doc. A leaf module, not the Worker entry: workerd
// reads every export of the entry as an entrypoint, and a number there refuses the worker at
// startup (cf#1244). Tests import from here.

/** How long a film run draws before its film doc must exist. The core writes the doc once, right after
 *  it invokes this module, so a doc still missing after this means the tick that started the run died.
 *  Longer than the 300 s film advance lease, so a live tick always gets to write it. */
export const FILM_DOC_GRACE_MS = 6 * 60 * 1000;
