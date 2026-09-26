### docs(legal): TERMS.md section 6 names the provider terms, per door (cf#755)

Section 6 said third-party providers are "YOUR own accounts", which is true only of
self-hosting. It now has two arms: 6.1 (self-host) keeps that statement and names the two
provider terms that change what the software may lawfully do, BFL's Terms of Service on the
Workers AI FLUX path (1.3(n): no using Output to train, distill or fine-tune any other AI
model; 1.2(c) consent for real, identifiable individuals; 1.3(m), 1.3(p); Usage Policy) and
the Gemini API Additional Terms (18+; no service directed at or likely to be accessed by
under-18s); 6.2 (hosted tenant door) states that those providers run on Skyphusion Labs'
accounts, bind the project, and are flowed down through the hosted AUP. 6.2 lands only with
the launch-gate flip (vivijure-control-plane `docs/legal/hosted/LAUNCH-GATE-PROCEDURE.md`).

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/751
