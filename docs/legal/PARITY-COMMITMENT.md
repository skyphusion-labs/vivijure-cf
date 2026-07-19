# The parity commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PARITY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PARITY-COMMITMENT.md).

The parity commitment is **constellation-wide**, not a studio artifact. It binds the whole of
Vivijure, so it lives at the hub in one copy, and this repository and `vivijure-control-plane` point
at it rather than carrying their own. A commitment that exists in three places is a commitment that
will eventually say three different things.

This file is a pointer so they can never drift. Do not paste the text here.

## What it says, in one line

Every feature ships to hosted and self-host at the same time, in the same release. There is no
community edition, no paid tier that unlocks capability, and no feature held back to make the hosted
version look better. What you pay for, if you ever pay anything, is convenience. Never capability.

## Why the pointer sits here

This repository **is** the self-host side of that promise. The studio panel a self-hoster deploys
and the studio a hosted tenant runs are built from the same published release out of this repo, so
parity is not maintained by discipline, it is a property of where the artifact comes from.

**If a code path here ever branches on whether it is running hosted or self-hosted in a way that
changes what a user can DO (as opposed to how it is billed or provisioned), the commitment stops
being true, and whoever adds it owns updating the canonical document in the same PR.** See Section 5
of the canonical copy for the full set of drift tripwires.
