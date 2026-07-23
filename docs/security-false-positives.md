# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Operator-controlled deploy inputs

`deploy.sh` substitutes `DEPLOY_HOSTNAME` and store ids via sed. Values come from the operator's shell environment at deploy time, not from untrusted HTTP input. A malicious operator already controls the Worker.

## Demo gallery video URLs

`demo-steer.js` loads `output_key` URLs from demo render rows written by the studio's demo queue. Demo output origins are operator-configured (`artifactOrigin`); this is not an open redirect from user-supplied keys.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 repo | deploy.sh sed without escaping | Operator-controlled deploy env |
| 2026-07-23 | K3 repo | Demo gallery arbitrary video URLs | Demo queue rows; operator-configured artifact origin |
