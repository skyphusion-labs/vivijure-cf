### fix(containers): one fetch setting across the CPU containers

`guarded_get` and `guarded_put` now set `allow_redirects=False` themselves, so all five containers behave the same way and no call site has to repeat it.
