#!/bin/sh
# check-skill.sh <skill folder>: says in one line what stops this folder from working as a skill in Claude Code, OpenCode and
# Antigravity alike; prints nothing when it is fine. The rules are the Agent Skills standard, the strictest of the three
# (Antigravity drops a SKILL.md that breaks them): the folder name is 1-64 lowercase letters, digits and single hyphens, and
# SKILL.md starts with frontmatter whose `name` is exactly the folder name and whose `description` is 1-1024 characters.
d="${1%/}"; n=${d##*/}
case "$n" in
  ""|*[!a-z0-9-]*|-*|*-|*--*) echo "folder name must be lowercase letters, digits and single hyphens"; exit 0 ;;
esac
[ "${#n}" -le 64 ] || { echo "folder name is longer than 64 characters"; exit 0; }
[ -f "$d/SKILL.md" ] || { echo "no SKILL.md in the folder"; exit 0; }
awk -v dir="$n" '
  function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
  function unq(s) { s = trim(s); if (s ~ /^".*"$/ || s ~ "^\047.*\047$") s = substr(s, 2, length(s) - 2); return s }
  NR == 1 { if (trim($0) != "---") { bad = "SKILL.md has no frontmatter (it must start with ---)"; exit } next }
  trim($0) == "---" { closed = 1; exit }
  /^name:/ { v = $0; sub(/^name:/, "", v); name = unq(v); hasname = 1; mode = ""; next }
  /^description:/ { v = $0; sub(/^description:/, "", v); v = trim(v); hasdesc = 1; mode = ""
    if (v ~ /^[>|][-+]?$/) mode = "block"; else desc = unq(v)
    next }
  mode == "block" && /^[ \t]/ { desc = desc trim($0); next }
  { mode = "" }
  END {
    if (bad != "") { print bad; exit }
    if (!closed) { print "SKILL.md frontmatter is not closed (the second --- is missing)"; exit }
    if (!hasname || name == "") { print "SKILL.md has no name: it must be \"" dir "\""; exit }
    if (name != dir) { print "name in SKILL.md is \"" name "\" but the folder is \"" dir "\": they must be the same"; exit }
    if (!hasdesc || desc == "") { print "SKILL.md has no description"; exit }
    if (length(desc) > 1024) { print "description is longer than 1024 characters"; exit }
  }' "$d/SKILL.md"
