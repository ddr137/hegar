#!/bin/sh
# check-agent.sh <agent file on the shelf>: says in one line what stops this file from working as a subagent in Claude Code,
# OpenCode and Antigravity alike; prints nothing when it is fine. The file is <name>.md: <name> is 1-64 lowercase letters,
# digits and single hyphens; it starts with frontmatter whose `name` is that name and whose `description` is on ONE line (1-6000
# characters), and it has instructions after the frontmatter. (Toolkit writes each agent's own file from these three things.)
f="$1"; n=${f##*/}; n=${n%.md}
case "$n" in
  ""|*[!a-z0-9-]*|-*|*-|*--*) echo "file name must be lowercase letters, digits and single hyphens"; exit 0 ;;
esac
[ "${#n}" -le 64 ] || { echo "name is longer than 64 characters"; exit 0; }
[ -f "$f" ] || { echo "no such file"; exit 0; }
awk -v dir="$n" '
  function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
  function unq(s) { s = trim(s); if (s ~ /^".*"$/ || s ~ "^\047.*\047$") s = substr(s, 2, length(s) - 2); return s }
  NR == 1 { if (trim($0) != "---") { bad = "no frontmatter (the file must start with ---)"; exit } next }
  !closed && trim($0) == "---" { closed = 1; next }
  !closed && /^name:/ { v = $0; sub(/^name:/, "", v); name = unq(v); hasname = 1; next }
  !closed && /^description:/ { v = $0; sub(/^description:/, "", v); v = trim(v); hasdesc = 1
    if (v ~ /^[>|][-+]?$/) block = 1; else desc = unq(v)
    next }
  !closed && /^tools:/ { v = $0; sub(/^tools:/, "", v); tools = trim(v); hastools = 1; next }
  !closed && /^model:/ { v = $0; sub(/^model:/, "", v); model = trim(v); hasmodel = 1; next }
  closed && trim($0) != "" { body = 1 }
  END {
    if (bad != "") { print bad; exit }
    if (!closed) { print "frontmatter is not closed (the second --- is missing)"; exit }
    if (!hasname || name == "") { print "no name: it must be \"" dir "\""; exit }
    if (name != dir) { print "name is \"" name "\" but the file is " dir ".md: they must be the same"; exit }
    if (block) { print "the description must be on one line"; exit }
    if (!hasdesc || desc == "") { print "no description"; exit }
    if (length(desc) > 6000) { print "description is longer than 6000 characters"; exit }
    if (hastools && tools == "") { print "tools must be one line (like: tools: Read, Grep), or left out"; exit }
    if (hastools && (length(tools) > 500 || tools !~ /^[A-Za-z0-9_.,:*() -]+$/)) { print "tools has characters or a length that Toolkit does not carry (letters, digits, commas, spaces, parentheses)"; exit }
    if (hasmodel && (model == "" || length(model) > 100 || model !~ /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/)) { print "model must be one plain word or id (like sonnet), or left out"; exit }
    if (!body) { print "no instructions after the frontmatter"; exit }
  }' "$f"
