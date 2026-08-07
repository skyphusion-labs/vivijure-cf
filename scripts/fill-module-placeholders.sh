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
#   REQUIRED  -- the module has no other path. audio-master, beat-sync, film-titles and subtitle
#                reach their CPU containers ONLY over their VPC binding; unbound, they soft-degrade
#                (`no-vpc-binding`) and the film ships without that phase. That is a silent
#                capability loss, so an unset id must REFUSE THE DEPLOY. Unchanged from before.
#
#   OPTIONAL  -- the binding is an ALTERNATIVE to a path that still works without it. cf#480's
#                finish/speech doors are the case: unbound, the module uses RunPod exactly as it
#                always has. An unset id therefore STRIPS the block and deploys, rather than
#                refusing.
#
# WHY NOT JUST MAKE EVERY VPC ID OPTIONAL. Because that removes a working guard. A misconfigured
# operator deploy would silently ship audio-master with no container path and degrade the master
# phase, and nothing would report it. "Make the failing check pass" is how a symptom-shaped fix
# deletes the control (the exclusion-into-nonexistence shape). The classes are declared, not
# inferred, so adding a binding forces a decision about which one it is.
#
# WHY AN UNSET OPTIONAL ID STRIPS RATHER THAN LEAVES THE BLOCK. A `[[vpc_services]]` block naming a
# service id that does not exist DANGLES THE DEPLOY -- wrangler fails on the binding. So "optional"
# has to mean optional all the way down: if the block cannot be removed when the id is absent, the
# module's unbound branch is unreachable in production and the compatibility guarantee it rests on
# is fiction. The self-host installer already reasons this way (`render_module_toml` in
# deploy/vivijure_deploy.py strips [[vpc_services]] unconditionally, because a base install
# provisions no media stack); this is the same rule applied per-binding instead of wholesale.
# ------------------------------------------------------------------------------------------------
set -eu

toml="${1:?usage: fill-module-placeholders.sh <wrangler.toml>}"
[ -f "$toml" ] || { echo "::error::no such toml: $toml" >&2; exit 1; }

here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

# Scalars. Their "must be set" pre-flight lives in the caller, which checks once rather than once
# per module; this script substitutes whatever it is given and lets the survivor check below catch
# an empty one.
sed -i "s/REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID/${SECRETS_STORE_ID:-}/g" "$toml"
sed -i "s/REPLACE_WITH_D1_DATABASE_ID/${D1_DATABASE_ID:-}/g" "$toml"

# --- REQUIRED VPC ids: substitute; an unset one is caught by the caller's pre-flight and, failing
# --- that, by the survivor check at the bottom of this file.
for v in VPC_VIDEO_FINISH_ID VPC_AUDIO_BEAT_SYNC_ID VPC_AUDIO_MASTER_ID; do
  placeholder="REPLACE_WITH_${v}"
  grep -q "$placeholder" "$toml" || continue
  eval "val=\${$v:-}"
  # FAIL CLOSED on an empty required id. Substituting "" would REMOVE the placeholder, so the
  # survivor check below would find nothing and the module would deploy with `service_id = ""` --
  # a dangling binding that the guard exists to prevent, waved through by the guard's own fill
  # step. The caller pre-flights these too; this makes the extracted half sound on its own rather
  # than dependent on a check in a different file.
  if [ -z "$val" ]; then
    echo "::error::${toml} needs ${v} and it is unset -- ${placeholder} is a REQUIRED binding (this module has no path without it), refusing" >&2
    exit 1
  fi
  sed -i "s/${placeholder}/${val}/g" "$toml"
done

# --- OPTIONAL VPC ids: set -> substitute. Unset -> strip the block that names the placeholder.
# A degrade is never silent, so the strip is LOGGED with the module it happened to (#249/#77).
# An optional binding is more than one block: cf#480's door needs a [[vpc_services]] block AND a
# [[secrets_store_secrets]] block for its bearer. Each block carries the marker
# `cf482-optional:<VAR>` in a comment, so the binding declares its own extent and the stripper does
# not have to guess which block types belong to it.
for v in VPC_FINISH_UPSCALE_ID VPC_SPEECH_UPSCALE_ID; do
  marker="cf482-optional:${v}"
  grep -q "$marker" "$toml" || continue               # this module does not declare that binding
  eval "val=\${$v:-}"
  if [ -n "$val" ]; then
    sed -i "s/REPLACE_WITH_${v}/${val}/g" "$toml"
    echo "  ${toml}: ${v} set -- bound the optional VPC service"
  else
    # awk exits 3 when it dropped nothing, so a strip that silently matches NOTHING cannot read as
    # a successful strip -- the failure mode of an in-place edit is that it quietly does nothing.
    tmp="${toml}.cf482.tmp"
    if awk -v MARKER="$marker" -f "${here}/strip-vpc-block.awk" "$toml" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$toml"
      echo "  ${toml}: ${v} unset -- stripped its optional blocks; this module keeps its RunPod path"
    else
      rm -f "$tmp"
      echo "::error::${toml} carries ${marker} but no block matching it -- refusing rather than deploying a dangling binding" >&2
      exit 1
    fi
  fi
done

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
