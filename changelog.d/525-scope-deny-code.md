### Fixed: scope denial is distinguishable from a dead credential (cf#525)

A consumer token hitting an operator route still returns **403**. The body now
carries `code: "scope_denied"` (and header `X-Vivijure-Authz`) so a client can
tell authorization-failure from a missing/bad token. `AUTHZ_DENY_REASON` still
does not trip the paste-once prompt. The panel shows a banner: re-issue with
operator scope.

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/525
