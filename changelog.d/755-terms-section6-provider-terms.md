### docs(legal): TERMS.md section 6 names the provider terms, per door (cf#755)

Section 6 said third-party providers are "YOUR own accounts", which is true only of
self-hosting. It now has two arms: 6.1 (self-host) keeps that statement and points to the two
provider terms a self-hoster should read before relying on a path, BFL's Terms of Service on the
Workers AI FLUX path (including 1.3(n), 1.2(c), 1.3(m), 1.3(p) and the Usage Policy) and the
Gemini API Additional Terms (18+; no service directed at or likely to be accessed by under-18s),
without interpreting how they apply; 6.2 (hosted tenant door) states that those providers run on
Skyphusion Labs' accounts, bind the project, and that conduct rules are flowed down through the
hosted AUP. 6.2 lands only with the launch-gate flip (vivijure-control-plane
`docs/legal/hosted/LAUNCH-GATE-PROCEDURE.md`).

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/751 (ruled 2026-09-26: the Cloudflare
path is compliant, per business counsel; section 6.1 therefore does not assert the opposite).
