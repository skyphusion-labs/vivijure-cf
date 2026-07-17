# Hosted studio -- legal scaffolding

> **Status: DRAFT. Nothing in this directory is in force.** These documents take effect when the
> hosted studio opens to signups. Until then the in-force documents are the ones in the parent
> directory (`../PRIVACY.md`, `../TERMS.md`, `../ACCEPTABLE-USE.md`), and they are correct as
> written, because today there is no hosted service.

> **Not legal advice.** Written by Ernst (Conrad's legal-affairs helper, who is named after a lawyer
> and is not one). This is structure and research, not legal advice, and it does not create an
> attorney-client relationship. **Counsel review is required before the hosted studio opens.** The
> specific questions are in `COUNSEL-REVIEW-CHECKLIST.md`.

This directory holds the legal scaffolding for the hosted BYO-RunPod-key tier (epic #40, this issue
#57). It exists as a separate directory, rather than as edits to the in-force documents, for one
reason: **the in-force documents are true today and must stay true until launch.** See
"Launch-gate: flipping the in-force documents" below.

## The documents

| File | What it is |
|---|---|
| [`aup/1.0.0.md`](aup/1.0.0.md) | **The AUP text the signup gate serves.** Versioned, immutable, self-contained. This is the exact text a tenant accepts. |
| [`PRIVACY-DELTA.md`](PRIVACY-DELTA.md) | What changes about privacy when we hold accounts and tenant studio data. Draws the controller/processor boundary, including where RunPod sits. Specifies the edits the in-force `../PRIVACY.md` needs at launch. |
| [`ABUSE-AND-NCMEC.md`](ABUSE-AND-NCMEC.md) | Abuse-handling posture for a hosted generative surface: who reports, what is preserved, what we scan for (and do not), and the operational runbook. |
| [`COUNSEL-REVIEW-CHECKLIST.md`](COUNSEL-REVIEW-CHECKLIST.md) | The specific questions a real, practicing lawyer must answer. Split into what blocks tier 1 and what blocks tier 2. |
| [`PARITY-COMMITMENT.md`](PARITY-COMMITMENT.md) | The anti-rug-pull parity wording for the public docs, plus the over-promise review of it. |

## The AUP versioning + acceptance contract (build to this)

This is the part the control plane (#52) implements. It is small and it is strict, because an
acceptance record is worthless if you cannot prove what was accepted.

**1. Version files are immutable.** `aup/<semver>.md` is written once and never edited. A
correction, however small, is a NEW file. If a served version file ever changes, every acceptance
record pointing at it becomes unprovable.

**2. The gate serves a pinned version.** The control plane pins the current version explicitly in
config (e.g. `AUP_VERSION=1.0.0`). It does not resolve "latest" at runtime, so a merged file cannot
silently change what new users are agreeing to.

**3. Acceptance is blocking.** No account is provisioned and no tenant studio is created without a
recorded acceptance. The gate fails closed: no acceptance record, no provisioning. This is a
precondition of the provisioner (#53), not a checkbox the UI can skip.

**4. Acceptance is logged, with enough to prove it.** The `aup_acceptances` record (control-plane
D1, per spec section 2) should carry at minimum:

| Field | Why |
|---|---|
| `account_id` | Who accepted. |
| `aup_version` | Which version (e.g. `1.0.0`). |
| `aup_sha256` | **SHA-256 of the exact served bytes.** This is what makes the record provable: it pins the content, not just a label. Verify it against the version file at serve time; a mismatch is a fail-closed error, not a warning. |
| `accepted_at` | When (UTC). |
| `ip` | From where. Retention-limited; see `PRIVACY-DELTA.md`. |
| `user_agent` | Context for the same. |

**5. Acceptance is affirmative.** A specific, unticked action ("I have read and accept the
Acceptable Use Policy"), not a pre-ticked box and not "by continuing you agree." This is a
clickwrap-vs-browsewrap enforceability point and it is cheap to get right; see
`COUNSEL-REVIEW-CHECKLIST.md` (T1-7).

**6. A new version requires re-acceptance.** On a material change, existing tenants are gated into
accepting the new version before they keep using the studio. Old acceptance records are retained,
never overwritten: they are the evidence of what that tenant agreed to at that time.

**7. Old versions stay served and readable.** A tenant whose record says `1.0.0` must be able to
read `1.0.0`. Version files are never deleted.

## Version changelog

| Version | Date | Status | Change |
|---|---|---|---|
| `1.0.0` | (unreleased) | DRAFT | Initial hosted AUP. Not in force; awaiting counsel review and launch. |

## Drift: this AUP vs the canonical constellation AUP

The **canonical constellation AUP** lives at the project hub
(`skyphusion-labs/vivijure`, `docs/legal/ACCEPTABLE-USE.md`) and is the policy for the software and
for self-hosting. The hosted AUP here is a **separate, self-contained instrument** for the hosted
service.

It is deliberately self-contained rather than incorporating the hub AUP by reference, because a
signup instrument cannot bind a user to text in another repository that can change after they
accepted it. The cost of that choice is drift risk: the two documents state the same prohibitions
and can diverge.

**The sync duty:** a change to the prohibitions in either document is a prompt to review the other.
The CSAM red line (Section 1) and the NCII/deepfake sections must never diverge in substance. When
this list grows a third member, replace this note with a real drift check.

## Deliberate wording choice, flagged for Conrad's override

The canonical hub AUP opens with a deliberately raw line aimed at people who would use this software
to hurt children. That voice is the project's and it is not an accident.

The hosted AUP here states the same prohibition with the same absoluteness but **without the
profanity**, because this document is a click-through instrument whose enforceability is a live
question (T1-7). That is a judgment call, not a softening: the red line in `aup/1.0.0.md` Section 1
is word-for-word as absolute as the hub's, and it adds the statutory reporting duty the hub version
does not have. **If Conrad wants the project's voice carried into the signup instrument verbatim,
that is his call and it is a one-line change.**

## Launch-gate: flipping the in-force documents

The in-force `../PRIVACY.md`, `../TERMS.md`, `../ACCEPTABLE-USE.md`, and `../README.md` all state,
correctly and repeatedly, that Skyphusion Labs does **not** run a hosted multi-tenant service and
holds no user data. **The day the hosted studio opens, those statements become false.**

They must not be edited before launch (that would make the in-force policy false in the other
direction, which is the same defect). The exact required edits are specified in
`PRIVACY-DELTA.md`, Section 7. **Flipping them is a launch-gate item, not a follow-up**, and it
belongs on the launch checklist next to the golden-checkpoint release pin.
