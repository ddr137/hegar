#!/bin/sh
# Prints "name<TAB>description" for every skill folder in $1. A description written as a YAML block (">-") takes its next line.
for d in "$1"/*/; do
  [ -d "$d" ] || continue   # an empty shelf leaves the pattern itself
  n=${d%/}; n=${n##*/}
  desc=$(awk '/^[Dd]escription:/ { v=$0; sub(/^[Dd]escription:[ \t]*/, "", v); if (v ~ /^[>|][-+]?$/) { getline v; sub(/^[ \t]+/, "", v) } print v; exit }' "$d/SKILL.md" 2>/dev/null)
  printf '%s\t%s\n' "$n" "$desc"
done
