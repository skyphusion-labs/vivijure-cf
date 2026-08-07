# strip-vpc-block.awk -- remove every top-level TOML block carrying MARKER.
#
# Used by fill-module-placeholders.sh when an OPTIONAL VPC service id is unset (cf#482): the
# binding's blocks must go, because a [[vpc_services]] block naming a service id that does not
# exist DANGLES THE DEPLOY. So "this binding is optional" is only true if its declaration can
# actually be removed; otherwise the module's unbound branch is unreachable in production and the
# compatibility guarantee it rests on is fiction.
#
# WHY MARKER-DRIVEN RATHER THAN `[[vpc_services]]`-DRIVEN. An optional binding is more than one
# block: cf#480's door needs a [[vpc_services]] block AND a [[secrets_store_secrets]] block for its
# bearer, and stripping only the first leaves wrangler resolving a Secrets Store entry that need
# not exist. The first version of this file keyed on the block TYPE and would have shipped exactly
# that half-strip. Keying on an explicit marker means a binding declares its own extent, and adding
# a third block to a group needs no change here.
#
# BLOCK BOUNDARY: a top-level TOML table header at column 0 (`[x]` or `[[x]]`) ends the previous
# block. Same boundary the shipped self-host stripper uses (`render_module_toml` in
# deploy/vivijure_deploy.py: `^\[\[vpc_services\]\].*?(?=^\[|\Z)`), so the two agree rather than
# each inventing a rule. It inherits that regex's one limitation, stated rather than discovered
# later: a `[` at column 0 INSIDE a multi-line array value would read as a new table. No module
# toml in this repo has one, and the survivor check downstream would catch the damage.
#
# THE PREAMBLE IS NEVER DROPPED. Everything before the first table header (the file's header
# comments, `name`, `main`, `compatibility_date`) is one pseudo-block, and a MARKER mentioned in a
# header comment must not delete the file's identity. Guarded explicitly rather than left to luck.
#
# EXIT 3 WHEN NOTHING WAS DROPPED. A filter that matches nothing emits its input unchanged, which is
# byte-identical to a successful no-op strip -- so silence here would let a renamed marker deploy
# with its placeholder intact and its blocks still present. The caller turns exit 3 into a named
# refusal. Same reason every matcher in this repo carries a positive control: an instrument that
# cannot report "I found nothing" is not reporting anything.

function flush(   i) {
  if (n == 0) return;
  if (!first && buf ~ MARKER) {
    dropped++;
  } else {
    for (i = 1; i <= n; i++) print lines[i];
  }
  first = 0; n = 0; buf = "";
}

BEGIN { first = 1 }

/^\[/ { flush() }

{ lines[++n] = $0; buf = buf "\n" $0 }

END {
  flush();
  if (dropped == 0) exit 3;
  print "stripped " dropped " block(s)" > "/dev/stderr";
}
