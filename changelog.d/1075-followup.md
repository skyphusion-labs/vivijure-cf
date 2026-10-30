### fix(modules): cf-vidu-q3-turbo reports has_audio, and retired doors leave the examples

`cf-vidu-q3-turbo` now reports `has_audio` on poll, as `cf-seedance` does, so the clip record says whether it carries talking audio. The expert JSON example in the planner names `cf-seedance`, because the old example named a retired door and returned a missing-door error when copied. Stale provider lists in module READMEs, comments and the deploy runbook no longer name retired doors.
