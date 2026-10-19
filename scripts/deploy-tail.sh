#!/usr/bin/env bash
# deploy-tail.sh -- render + deploy vivijure-tail (cf#294).
#
# vivijure-tail is an OPT-IN tier: it is the tail_consumers target that ships the core studio's
# render logs to a Loki the OPERATOR runs (docs/observability.md). It is stripped for a self-host
# default and for a WfP tenant (see the SELFHOST-SKIP strip in wrangler.toml.example /
# studio-release.yml), and it changes rarely.
#
# cf#838, 2026-09-27: the reference instance's Loki is gone and the root config no longer binds this
# worker, so this script deploys nothing WE consume today. It is kept, not deleted, because the
# shipper is generic and an operator with their own Loki is its actual audience; what died was the
# sink, not the tier. Deploying it against a VPC service with no Loki behind it is now LOUD rather
# than silent (see the sink_unreachable report in tail/src/index.ts).
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
# YOUR Loki; account-internal, not a credential, but not published -- see the .example header).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tail"

say()  { printf "\n==> %s\n" "$*"; }
info() { printf "    %s\n" "$*"; }
die()  { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

need() { local v; eval "v=\${$1:-}"; [ -n "$v" ] || die "$1 is required but unset/empty -- $2"; }
need CLOUDFLARE_ACCOUNT_ID "your Cloudflare account id"
need CLOUDFLARE_API_TOKEN  "a token with Workers Scripts: Edit + Workers VPC: Read"
need LOKI_VPC_ID           "the Workers-VPC service id for the Loki you run (not creatable via a documented CF API today, see wrangler.toml.example)"
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
info "done. Deployed as vivijure-tail."
info "NOTE: the core's tail_consumers line is COMMENTED OUT in wrangler.toml.example since cf#838."
info "      Uncomment it and redeploy the core to actually ship logs -- in that order, never before"
info "      this worker is live, or the core deploy fails on a dangling tail consumer."
