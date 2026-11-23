#!/bin/sh
# Prints "name<TAB>description<TAB>problem<TAB>fingerprint" for every skill folder in $1. The description of a YAML block (">-") is its next
# line. The problem is what check-skill.sh says (empty when the skill is fine for every agent).
here=$(dirname "$0")
for d in "$1"/*/; do
  [ -d "$d" ] || continue   # an empty shelf leaves the pattern itself
  n=${d%/}; n=${n##*/}
  desc=$(awk '/^[Dd]escription:/ { v=$0; sub(/^[Dd]escription:[ \t]*/, "", v); if (v ~ /^[>|][-+]?$/) { getline v; sub(/^[ \t]+/, "", v) } print v; exit }' "$d/SKILL.md" 2>/dev/null | tr '\t' ' ')
  problem=$(sh "$here/check-skill.sh" "$d" | tr '\t' ' ')
  printf '%s\t%s\t%s\t%s\n' "$n" "$desc" "$problem" "$(sh "$here/fingerprint.sh" "$d")"
done
