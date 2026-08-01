#!/usr/bin/env bash
# deploy-tail.sh -- render + deploy vivijure-tail (cf#294).
#
# vivijure-tail is OUR-fleet-only: it is the tail_consumers target that ships the core studio's
# render logs to Loki (docs/observability.md), it has no meaning for a self-host or a WfP tenant
# (see the SELFHOST-SKIP strip in wrangler.toml.example / studio-release.yml), and it changes rarely.
# It does not belong in deploy.sh (the self-host script) or the tag-gated CI release job (which
# deploys the module fleet + the core), so it is a small standalone script instead -- run BY HAND
# when tail needs to be (re)deployed, same discipline as every other example/render pair in this
# repo (docs/deploy-config-injection.md), just without the CI wiring that pattern usually implies.
#
# Before cf#294, tail/wrangler.toml.example existed (recovered from the live worker, cf#148) but
# nothing rendered from it -- an operator had to hand-edit a config or guess at the real one. This
# closes that gap: the example is now the actual source the deployed config is rendered from.
#
# Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, LOKI_VPC_ID (the Workers-VPC service id for
# the fleet's Loki; account-internal, not a credential, but not published -- see the .example header).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tail"

say()  { printf "\n==> %s\n" "$*"; }
info() { printf "    %s\n" "$*"; }
die()  { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

need() { local v; eval "v=\${$1:-}"; [ -n "$v" ] || die "$1 is required but unset/empty -- $2"; }
need CLOUDFLARE_ACCOUNT_ID "your Cloudflare account id"
need CLOUDFLARE_API_TOKEN  "a token with Workers Scripts: Edit + Workers VPC: Read"
need LOKI_VPC_ID           "the Workers-VPC service id for the fleet Loki (recorded in the private store; not creatable via a documented CF API today, see wrangler.toml.example)"
command -v envsubst >/dev/null || die "envsubst not found -- install gettext (apt-get install gettext-base)"

export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

say "Rendering tail/wrangler.toml from wrangler.toml.example"
export LOKI_VPC_ID
VARS="\$LOKI_VPC_ID"
envsubst "$VARS" < wrangler.toml.example > wrangler.toml

# Fail closed: no placeholder may survive outside a comment (mirrors the core render's guard,
# docs/deploy-config-injection.md section 3d/6). A missing or misnamed var would otherwise ship a
# dangling vpc_services binding, and wrangler deploy would fail anyway, but with a far less obvious
# reason than this check gives.
if grep -v '^[[:space:]]*#' wrangler.toml | grep -qF '${'; then
  grep -nF '${' wrangler.toml | grep -v ':[[:space:]]*#'
  die "unsubstituted placeholder left in wrangler.toml"
fi
grep -Eq 'service_id = "[^"$]+"' wrangler.toml || die "LOKI_VPC_ID rendered empty -- refusing to deploy a dangling vpc_services binding"
info "rendered wrangler.toml ($(wc -l < wrangler.toml) lines)"

say "Deploying vivijure-tail"
npx wrangler deploy -c wrangler.toml
info "done. The core's tail_consumers binding (wrangler.toml.example) expects this worker to be live under the name vivijure-tail."
