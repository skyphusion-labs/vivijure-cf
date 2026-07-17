# The hosted studio: what it is, what it costs, and how to leave

**Status: in build (sprint #40). This page documents the hosted tier as specced and ruled. It goes
live with the tier; nothing here describes a running service yet.**

Vivijure is free software you can install yourself, and always will be. The hosted studio exists for
one reason: installing takes work, and some people would rather skip that part. You sign up, paste
one RunPod key, and a few minutes later you have your own studio that can write a storyboard and
render it to video.

You still own the GPUs. You still own your films. The only thing we do is run the control panel for
you, so you never have to set one up.

Want to install it yourself instead? That path is first-class and fully supported. Start at
[quickstart.md](quickstart.md).

---

## Our promise, in writing

> **Hosted and self-host ship the same studio. Features never gate on payment.**

We mean that literally, so here is what it rules out:

- No feature ever ships to hosted first and self-host "later." Same release, or it does not ship.
- No community edition. No paid-only capability. No feature held back to sell you an upgrade.
- The hosted control plane itself (signup, the provisioner, routing, quotas) is **AGPL source in
  this repo**. Anyone who wants to run a competing hosted vivijure can, with our blessing.

The hosted tier sells convenience: no install, no infrastructure. It never sells capability. What
differs between hosted and self-host is who runs the metal, and nothing else.

That last point is what makes the promise checkable rather than just nice words. You can read
exactly what the hosted tier runs, because it is the same published release you would install
yourself, and the door in front of it is source you can read too.

---

## What gets created on your RunPod account

Before we touch your account, the setup screen shows you this same list. Nothing is created until
you say go.

We create **4 serverless endpoints** on your RunPod account, built from our public release images
on GHCR:

| Endpoint | What it does | Image |
|---|---|---|
| **backend** | The main render: keyframes, video, and cast LoRA training | `ghcr.io/skyphusion-labs/vivijure-backend` |
| **upscale** | Makes finished video sharper | `ghcr.io/skyphusion-labs/vivijure-upscale` |
| **lipsync** | Matches mouth movement to dialogue | `ghcr.io/skyphusion-labs/vivijure-musetalk` |
| **audio-upscale** | Cleans up and sharpens audio | `ghcr.io/skyphusion-labs/vivijure-audio-upscale` |

They are yours. They live on your account, under your billing, and you can see, change, or delete
them from your RunPod dashboard at any time without asking us.

**All four are scale-to-zero.** A serverless endpoint with nothing to do runs no workers, and a
worker that is not running costs nothing. This is the whole design idea behind vivijure: you rent a
very fast GPU by the second while your film renders, and you rent nothing at all the rest of the
time.

> **Idle costs you $0.** Not "a few cents." Zero. If you render one film this month, you pay for the
> minutes that film took, and nothing else.

---

## The key we ask for, and why

You give us a RunPod API key **once**, during setup. We use it to create those 4 endpoints, and then
we are done with it. Here is exactly what to make:

> **In your RunPod console, create a key with the Restricted setting:**
> - set **api.runpod.io/graphql** to **Read/Write**
> - leave **api.runpod.ai** (the invoke surface) at **None**

That is the smallest key that can still create endpoints. We checked this against the real API
rather than trusting the documentation, because RunPod's own docs do not describe this pane.

**Now the honest part.** That key is powerful. RunPod does not offer a "may only create endpoints"
permission, so a key that can create your 4 endpoints can also create pods anywhere on your account
while it exists. RunPod says so themselves: GraphQL access is "an extremely powerful level of
access." There is no smaller key that does the job. We wish there were.

So we treat it the way you would want:

- It is used **once**, during setup, and held only in memory while your endpoints are built.
- It is **never stored**. Not in a database, not in a log, not on your studio.
- When setup finishes, **delete it from your RunPod console**. We show you that step and link you
  straight to it. Nothing breaks when you do, because we are already done with it.

### What your studio actually keeps

After setup, your studio holds a **second, much weaker key**: a Restricted key scoped to invoke
**only your 4 endpoints**. That is all a render needs: submit a job, check on it, cancel it.

We tested that boundary rather than assuming it:

- it can start and check jobs on your 4 endpoints, and
- it gets a flat **403 Forbidden** on any endpoint that is not one of those 4, and
- it cannot change your endpoint settings at all (a **401**, even on your own endpoints).

So the worst case for the key we store is "someone could run renders on your four endpoints." The
worst case is not your RunPod account.

---

## What a render costs

You pay RunPod directly for GPU seconds. We never touch that money, we never mark it up, and there
is no vivijure bill at all in this tier.

The math is simple: **GPU seconds used, times your GPU's per-second rate.** The default render GPUs
are H200 class, which RunPod lists at **$3.59/hr (community) to $4.39/hr (secure)** as of
2026-07-17.

Here is a real render from our own history, not an estimate:

> **A 2-shot film, 10 seconds of finished video, final quality.**
> Job `film-2294a9d7-d994-4807-8ed8-301a8e2fd796`, rendered 2026-07-14.
> Start to finish: **6 minutes**. Cost at the $4.39/hr secure rate: **about $0.44.**

**That $0.44 is a ceiling, and here is why.** Six minutes is wall-clock time from when the job was
submitted, and that includes time the job spent waiting in a queue and time the worker spent loading
the model. RunPod bills you for active worker seconds, which is less than that. So the real bill for
that film is somewhere below 44 cents. We would rather quote you a number we can prove and let you
be pleasantly surprised than quote you a prettier one we cannot stand behind.

After your first render, stop reading estimates: your studio shows your real spend, and RunPod's
dashboard shows the real bill.

Costs scale with how much video you make. Longer films, more shots, and the finish steps (sharper
video, lip-sync) all add GPU seconds. The finish steps run on cheaper GPUs than the main render.

### The other bills

- **RunPod**: GPU seconds, as above. You fund your own account. This is the real cost of a render.
- **The planner's AI**: writing a storyboard calls an AI model, and that is pennies per storyboard.
  In the hosted tier we cover it.
- **Us**: nothing. There is no bill, no card, no credits, no plan.

---

## Your account's real capacity

RunPod limits how many workers you can run at once. This is called your **worker quota**, and it is
counted across your whole account.

**We do not guess your quota from a table.** RunPod publishes a chart that maps your account balance
to a quota, and we found that chart to be wrong: an account funded with $50 had the full quota of 10
from day one, where the chart promised 5. So we do not use it.

Instead, **we check your account's real capacity during setup** and show you the actual number we
found. Then we fit your 4 endpoints inside it, and we pin the worker count on each endpoint
explicitly rather than taking RunPod's default of 3 per endpoint (4 endpoints at that default would
ask for 12 workers and fail).

If your real quota is too small for 4 endpoints, we stop and tell you the exact number we found and
what to do about it. We do not half-build your studio and leave you to sort out the wreckage.

---

## One thing that will surprise you: the 7-day sleep

This is RunPod's behavior, not ours, and it hits self-hosters exactly the same way. We are telling
you up front because finding out on your own is unpleasant:

- **3 days with no renders**: RunPod quietly cuts your endpoints to 2 max workers.
- **7 days with no renders**: RunPod sets your endpoints to **0 max workers**, and leaves them there
  until someone raises them by hand.

So a studio you did not touch for a week can come back to 4 endpoints that cannot render. Nothing is
lost or broken; the number just needs raising.

The key your studio holds deliberately cannot change that setting (that is the security tradeoff
above, and we chose it on purpose). What your studio can do is see the problem, so it tells you
plainly what happened and walks you through the fix instead of failing a render with a confusing
error. That work is tracked in issue #61 and lands for hosted and self-host in the same release,
like everything else.

---

## Your data, and how to leave

**Your films and your storyboards are yours.** Leaving is a supported path, not a punishment.

Your studio is a real, complete vivijure studio: its own database, its own storage bucket, its own
worker. That is not a detail; it is what makes leaving possible at all.

- **Your storyboards, cast, and render history** live in your own database. You can export the whole
  thing to a SQL file.
- **Your films, keyframes, and audio** live in your own storage bucket, as ordinary files you can
  download.
- **Your GPU endpoints** are already on your own RunPod account, and we never had any other claim on
  them.

**If you delete your studio, we offer you the export first.** You take the SQL file and your files,
and then it is gone. We do not hold your work hostage to keep you around, and there is no "contact
sales to export" step. Your RunPod endpoints stay yours; we show you a checklist to delete them if
you want them gone, and we never touch your RunPod account beyond the setup you authorized.

Taking that export and running it yourself gives you the same studio, on your own Cloudflare
account. See [quickstart.md](quickstart.md).

---

## The rules

<!-- AUP-PLACEHOLDER-START: Ernst owns this text (issue #57). Do not write policy copy here.
     When #57 lands, replace this block with the real acceptable-use summary and the links to the
     hosted AUP, terms, and privacy pages. The signup screen embeds the same text from the same
     source. -->

> **Placeholder, pending issue #57.** The acceptable-use policy, terms, and privacy text for the
> hosted tier are being written and reviewed. They are not drafted here.

One line is not a placeholder and is not up for discussion: **vivijure has an absolute ban on child
sexual abuse material, including AI-generated material.** It is enforced, it is reported, and there
is no version of this product where that is negotiable.

<!-- AUP-PLACEHOLDER-END -->

Current legal text for the self-hosted studio is in [legal/](legal/).

---

## Where the details live

- [quickstart.md](quickstart.md) -- install your own studio instead. First-class, fully supported.
- [constellation.md](constellation.md) -- the one-page map of how the parts fit together.
- [DEPLOYMENT.md](DEPLOYMENT.md) -- the full self-host deployment reference.
- [opt-in-tiers.md](opt-in-tiers.md) -- the add-ons and what each one needs.
- [SECURITY.md](SECURITY.md) -- the security posture.
