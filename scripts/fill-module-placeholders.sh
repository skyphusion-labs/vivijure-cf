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
# regression and this script REFUSES rather than filling it. Do not mint media VPC ids;
# media is Traefik URL vars + MEDIA_FINISH_TOKEN.
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
#
# AND IT REPORTS WHAT IT STRIPPED (cf#840). An unset OPTIONAL door var is not an error: unset is
# the NORMAL state and the state a self-host ships in, so refusing it would break the ordinary
# path. What was missing is not a failure, it is a REPORT. cf#489 is the record of the cost: an id
# absent from the ci.yml env block strips the door it was meant to bind and the deploy stays
# GREEN, and the only tell was a log line that did not exist on this seam. A deliberate opt-out and
# a forgotten variable render BYTE-IDENTICALLY in the toml, so nothing downstream can tell them
# apart; the only place the difference is still knowable is HERE, before the substitution.
#
# Reported per module and only for vars THIS toml actually declares: a var a module never mentions
# is not a stripped door, and counting it would make the loud line noise that gets filtered out.
# The denominator is printed too, so "no doors" is stated rather than looking like no output.
#
# NAMES ONLY, never the value. These are repo VARIABLES rather than secrets, but an origin list is
# still deploy topology, and SET/EMPTY is the entire question this report answers.
door_declared=0
door_bound=""
door_stripped=""
for v in VIDEO_FINISH_URL AUDIO_MASTER_URL AUDIO_BEAT_SYNC_URL AUDIO_MIX_URL IMAGE_PREP_URL \
         FINISH_UPSCALE_DOORS FINISH_BLENDER_DOORS; do
  eval "val=\${$v:-}"
  # Declared on a LIVE line? -F keeps ${...} literal (the v0.16.2 MCP-guard lesson: '${' as a
  # regex is grep-dependent), and the comment strip keeps a documented example from counting.
  if grep -vE '^[[:space:]]*#' "$toml" | grep -qF "\${$v}"; then
    door_declared=$((door_declared + 1))
    if [ -n "$val" ]; then door_bound="$door_bound $v"; else door_stripped="$door_stripped $v"; fi
  fi
  escaped=$(printf '%s' "$val" | sed 's/[&|]/\\&/g')
  replace_in_place "s|\${${v}}|${escaped}|g"
done

if [ "$door_declared" -eq 0 ]; then
  echo "optional-doors: ${toml} declares 0 optional door vars -- nothing to bind or strip."
else
  echo "optional-doors: ${toml} declares ${door_declared} optional door var(s)."
  for v in $door_bound; do
    echo "optional-doors: BOUND    ${v} -- set, so this door is LIVE in ${toml}."
  done
  for v in $door_stripped; do
    echo "::warning::optional-doors: STRIPPED ${v} -- unset, so that door is OFF in ${toml} (RunPod/degrade path) and this deploy still succeeds. cf#489/cf#840: a forgotten variable looks exactly like a deliberate opt-out here, so confirm this was intended."
  done
fi

# Hosted no longer ships [[vpc_services]] or ${VPC_ on module tomls. Leftover is a regression.
if grep -vE '^[[:space:]]*#' "$toml" | grep -q '^\[\[vpc_services\]\]'; then
  echo "::error::${toml} still carries [[vpc_services]] -- hosted media is Traefik URLs + MEDIA_FINISH_TOKEN; remove the block" >&2
  exit 1
fi
leftover_vpc="$(grep -vE '^[[:space:]]*#' "$toml" | grep -oE '\$\{VPC_[A-Z0-9_]+\}|REPLACE_WITH_VPC_[A-Z0-9_]+' | sort -u || true)"
if [ -n "$leftover_vpc" ]; then
  echo "::error::leftover VPC placeholder in ${toml}: $(echo "$leftover_vpc" | tr '\n' ' ')" >&2
  echo "::error::do not mint REPLACE_WITH_VPC_* / \${VPC_ ; media is URL vars + MEDIA_FINISH_TOKEN" >&2
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
