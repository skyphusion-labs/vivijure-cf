### ci(changelog): refuse a tag whose `changelog.d/` still holds an unconsumed fragment (cf#901)

**Three times in one night a change shipped inside a tag with no changelog entry and nothing
refused.** One of them was a child-safety fix.

- `v1.34.1` was HAND-WRITTEN instead of assembled, so both its fragments went unconsumed.
  `810-pool-vs-max-instances.md` survived only by the accident of the author writing the same
  content twice; `804-storage-posture-comment.md` was lost and had to be folded back afterwards as
  a post-publication correction.
- `v1.34.2` was assembled correctly and then two more PRs merged before the tag -- cf#858 (the
  shared CSAM needle) and cf#859 -- and then two more again, cf#862 and cf#863.

**IT RUNS AT TAG TIME, AND THAT IS THE DESIGN.** Only the first instance is a cut-time failure. The
others were fragments that did not exist when the assembler ran, so a cut-time check would have
passed honestly and the tag would still have shipped undescribed changes. **The tag is the last
boundary the artifact crosses, so it is the one that has to ask.**

**A HOLD IS DISTINGUISHED FROM AN OVERSIGHT, because `804` was held on purpose for hours.** A gate
that is wrong about the legitimate case is one somebody disables. The distinction reuses the
mechanism this repo already proved in `scripts/changelog-corrections.txt` (cp#245): **both halves
required, neither waives alone** -- the fragment listed in `scripts/changelog-holds.txt`, AND a
**first-line** `<!-- HELD: reason -->` marker in the fragment. Listed-but-unmarked is refused;
marked-but-unlisted is refused; a stale hold naming a fragment that no longer exists is refused;
and a reason under 12 characters is not a reason.

The marker is pinned to line 1 because cp#245's own regression was a waiver living in the content,
so a section merely DOCUMENTING the mechanism disarmed itself.
`tests/changelog-fragments-consumed.test.py` plants exactly that -- a fragment quoting
`<!-- HELD: ... -->` below its first line -- and requires a refusal.

**IT CAN REFUSE, and the control proves it before anything asserts a pass.** 12 planted cases, run
FIRST, including an unconsumed fragment and each half of the waiver alone. Not
`continue-on-error`: the `changelog-immutability` step in this repo is, and its green tick
therefore cannot tell a reader whether a waiver was accepted -- that had to be established by
running the script by hand during #899. **A gate that cannot refuse is documentation with a tick
next to it**, which is worse than nothing because the tick reads as an answer.

The gate runs in `assert-tag-version`; its control runs in the `changelog` workflow on **every**
PR, so the ability to refuse is exercised continuously rather than only on release days.
