#!/bin/sh
# fill-module-placeholders.sh <module-wrangler.toml>
#
# Fills every `REPLACE_WITH_*` placeholder in ONE module toml, in place, and refuses if any
# survives. Split out of deploy-module-workers.sh (cf#482) for one reason: that script's only
# caller is a TAG deploy, so every defect in it was invisible until a release. This half touches
# no network and no wrangler, so tests/deploy-placeholders-cf482.test.ts can drive the SHIPPED
# script rather than a re-implementation of it.
#
# ------------------------------------------------------------------------------------------------
# TWO CLASSES OF PLACEHOLDER, AND THE DIFFERENCE IS LOAD-BEARING (cf#482).
#
#   REQUIRED  -- store_id / D1 / R2 S3 identifiers the module cannot ship without.
#
#   URL VARS  -- VIDEO_FINISH_URL / AUDIO_*_URL / *_DOORS. Substituted from env; unset becomes
#                empty, which is the honest off state (degrade / RunPod). Never a baked hostname.
#
# Workers VPC is gone from hosted module tomls. A leftover [[vpc_services]] or ${VPC_ is a
# regression and this script REFUSES rather than filling it. setup-media-vpc.py stays on disk
# for the self-host installer; hosted no longer uses those ids.
# ------------------------------------------------------------------------------------------------
set -eu

toml="${1:?usage: fill-module-placeholders.sh <wrangler.toml>}"
[ -f "$toml" ] || { echo "::error::no such toml: $toml" >&2; exit 1; }

here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

# GNU sed -i and BSD sed -i '' disagree. tmp+mv is the portable form (BusyBox ash + macOS).
replace_in_place() {
  tmp="${toml}.fill.tmp"
  sed "$1" "$toml" > "$tmp" && mv "$tmp" "$toml"
}

# Scalars. Their "must be set" pre-flight lives in the caller, which checks once rather than once
# per module; this script substitutes whatever it is given and lets the survivor check below catch
# an empty one.
replace_in_place "s/REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID/${SECRETS_STORE_ID:-}/g"
replace_in_place "s/REPLACE_WITH_D1_DATABASE_ID/${D1_DATABASE_ID:-}/g"

# --- Media URL / door-list vars: substitute from env; unset becomes empty (honest off).
# Wrangler ${VAR} interpolation of an unset var deploys the LITERAL ${VAR} (v1.31.1 class).
# Filling here means empty-is-off rather than a hostname that is the placeholder text.
for v in VIDEO_FINISH_URL AUDIO_MASTER_URL AUDIO_BEAT_SYNC_URL AUDIO_MIX_URL IMAGE_PREP_URL \
         FINISH_UPSCALE_DOORS SPEECH_UPSCALE_DOORS FINISH_BLENDER_DOORS; do
  eval "val=\${$v:-}"
  escaped=$(printf '%s' "$val" | sed 's/[&|]/\\&/g')
  replace_in_place "s|\${${v}}|${escaped}|g"
done

# Hosted no longer ships [[vpc_services]] or ${VPC_ on module tomls. Leftover is a regression.
if grep -vE '^[[:space:]]*#' "$toml" | grep -q '^\[\[vpc_services\]\]'; then
  echo "::error::${toml} still carries [[vpc_services]] -- hosted no longer uses Workers VPC; remove the block" >&2
  exit 1
fi
leftover_vpc="$(grep -vE '^[[:space:]]*#' "$toml" | grep -oE '\$\{VPC_[A-Z0-9_]+\}|REPLACE_WITH_VPC_[A-Z0-9_]+' | sort -u || true)"
if [ -n "$leftover_vpc" ]; then
  echo "::error::leftover VPC placeholder in ${toml}: $(echo "$leftover_vpc" | tr '\n' ' ')" >&2
  echo "::error::hosted no longer fills REPLACE_WITH_VPC_* / \${VPC_ ; media is URL vars" >&2
  exit 1
fi

# --- R2 S3 identifiers (cf-grok-video ZDR upload_url). NOT secrets. -----------------------------
# Wrangler ${VAR} interpolation is a trap: an unset env var deploys the LITERAL
# ${R2_S3_ENDPOINT} and mintUploadUrl throws "Invalid URL string." (v1.31.1 live).
# These are REPLACE_WITH_* so the survivor check below catches a missed fill.
if grep -q "REPLACE_WITH_R2_S3_ENDPOINT" "$toml"; then
  endpoint="${R2_S3_ENDPOINT:-}"
  if [ -z "$endpoint" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    endpoint="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
  fi
  if [ -z "$endpoint" ]; then
    echo "::error::${toml} needs R2_S3_ENDPOINT (or CLOUDFLARE_ACCOUNT_ID to derive it) and it is unset -- refusing" >&2
    exit 1
  fi
  escaped=$(printf '%s' "$endpoint" | sed 's/[|&]/\\&/g')
  replace_in_place "s|REPLACE_WITH_R2_S3_ENDPOINT|${escaped}|g"
fi
if grep -q "REPLACE_WITH_R2_S3_BUCKET" "$toml"; then
  bucket="${R2_S3_BUCKET:-vivijure}"
  replace_in_place "s/REPLACE_WITH_R2_S3_BUCKET/${bucket}/g"
fi

# A raw wrangler interpolation that survived is the v1.31.1 defect. Refuse it here so a
# module toml cannot ship the literal again even if someone reverts the REPLACE_WITH_ form.
leftover="$(grep -vE '^[[:space:]]*#' "$toml" | grep -oE '\$\{R2_S3_[A-Z0-9_]+\}' | sort -u || true)"
if [ -n "$leftover" ]; then
  echo "::error::unfilled wrangler interpolation in ${toml}: $(echo "$leftover" | tr '\n' ' ')" >&2
  echo "::error::use REPLACE_WITH_R2_S3_* (filled by this script); a raw \${R2_S3_*} deploys as a literal" >&2
  exit 1
fi

# --- SURVIVOR CHECK -------------------------------------------------------------------------------
# COMMENT-AWARE (cf#482). The old check was a bare `grep -q "REPLACE_WITH_"`, which matches inside a
# `#` comment, and the script `exit 1`s -- so ONE commented-out example block in ONE module toml
# failed the deploy for EVERY module after it. Verified with both controls: a file containing only
# `# a comment mentioning REPLACE_WITH_VPC_FOO_ID` matched, and the same text written `<VPC_FOO_ID>`
# did not. An inert comment must be inert; documenting a binding at the point of use is exactly what
# a module author should be able to do.
survivors="$(grep -vE '^[[:space:]]*#' "$toml" | grep -oE 'REPLACE_WITH_[A-Z0-9_]+' | sort -u || true)"
if [ -n "$survivors" ]; then
  # NAME WHAT SURVIVED AND WHERE. The old message said "store_id placeholder survived" while this
  # check now guards five placeholder families, so an operator hitting a VPC problem was sent to
  # look at the Secrets Store. A diagnostic that names the wrong subsystem costs more than none.
  echo "::error::unfilled placeholder(s) in ${toml}: $(echo "$survivors" | tr '\n' ' ')" >&2
  echo "::error::set the matching repo secret/variable, or (for an OPTIONAL binding) leave it unset so its block is stripped" >&2
  exit 1
fi
