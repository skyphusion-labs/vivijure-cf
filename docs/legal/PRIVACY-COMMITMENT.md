# The privacy commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PRIVACY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PRIVACY-COMMITMENT.md).

The privacy commitment is **product-wide**, not a studio artifact. It covers every product
Skyphusion Labs ships (the Vivijure constellation, Postern, Prism, Slate), so it lives at the hub in
one copy and every product repository points at it rather than carrying its own. A commitment that
exists in six places is a commitment that will eventually say six different things.

This file is a pointer so they can never drift. Do not paste the text here.

## What it says, in one line

Privacy, autonomy, and agency are the primary goal, ranked above feature completeness rather than
traded against it; when a feature cannot be built without violating that, **we drop the feature, not
the line**; public source is the audit mechanism that makes the promise checkable; and the CSAM and
NCII bright line is the one stated exception.

## Why the pointer sits here

This repository is where the promise is most load-bearing, because it holds the **in-force**
[`PRIVACY.md`](PRIVACY.md) and [`TERMS.md`](TERMS.md), and it is the software a self-hoster actually
runs. The commitment names two facts about this repo specifically:

- **Vivijure self-hosted:** we operate nothing and hold nothing. Your instance never talks to us.
- **The Vivijure demo** (`demo.vivijure.com`): we operate it, and it holds nothing you submit. No
  account, no identity cookie, no analytics beacon, and it renders nothing.

`PRIVACY.md` is the detailed policy and remains canonical for this host. The commitment is the
standard that policy is written against; if the two ever disagree, that is a defect in one of them,
and the disagreement is the signal.

## The tripwire

**If this repository ever ships a build that phones home, collects telemetry, or otherwise sends
anything from a self-hosted instance back to us, the commitment stops being true, and whoever ships
it owns updating the canonical document in the same PR.** See the canonical copy for the full set of
drift tripwires and the operational-telemetry boundary.
