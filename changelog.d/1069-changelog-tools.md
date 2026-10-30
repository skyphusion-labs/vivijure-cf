### fix(ci): the changelog assembler respects holds, and the fragment gate refuses a bad root

`scripts/changelog-assemble.py` now leaves a held fragment in place and names it, and it refuses a fragment with only one half of a hold. It reads the rule from `scripts/changelog-fragments-consumed.py`, so the two cannot disagree. That gate now exits 2 on a root with no `changelog.d/`, where a version passed by mistake used to report OK on 0 fragments.
