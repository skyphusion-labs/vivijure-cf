#!/usr/bin/env bash
# Print the CHANGELOG.md body for one version tag (heading excluded), trimmed of blank edges.
# Usage: changelog-section.sh <tag> [changelog-path]   Exit 1 (no output) if the section is missing or empty.
set -euo pipefail
tag="${1:?usage: changelog-section.sh <tag> [changelog-path]}"
file="${2:-CHANGELOG.md}"
awk -v tag="$tag" '
  /^## / { if (on) exit; h=$2; if (h==tag) { on=1; next } }
  on { print }
' "$file" | awk 'NF{p=1} p{buf[++n]=$0} END{while(n&&buf[n]=="")n--; for(i=1;i<=n;i++)print buf[i]}' > "${TMPDIR:-/tmp}/cl-section.$$"
trap 'rm -f "${TMPDIR:-/tmp}/cl-section.$$"' EXIT
test -s "${TMPDIR:-/tmp}/cl-section.$$" || exit 1
cat "${TMPDIR:-/tmp}/cl-section.$$"
