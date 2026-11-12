### docs(legal): TERMS.md section 6 states provider terms per door (cf#755)

Section 6 said third-party providers are "YOUR own accounts", which is true only of
self-hosting. It now has two arms. 6.1 (self-host) says which provider terms reach an operator by
path: models reached through the operator's Cloudflare account carry the model provider's standard
terms under Cloudflare's own terms, a model reached with the operator's own key comes under that
contract, and RunPod is the operator's own contract. It lists the kinds of condition to look for
and interprets none. 6.2 (hosted tenant door) states that those providers run on Skyphusion Labs'
accounts, bind the project, and that conduct rules are flowed down through the hosted AUP. 6.2
lands only with the launch-gate flip (vivijure-control-plane
`docs/legal/hosted/LAUNCH-GATE-PROCEDURE.md`).

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/751 (ruled 2026-09-26: the Cloudflare
path is compliant, per business counsel; section 6 therefore does not assert the opposite).
