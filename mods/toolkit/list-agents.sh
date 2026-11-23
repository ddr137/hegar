#!/bin/sh
# list-agents.sh <agents folder on the shelf>: "name<TAB>problem<TAB>notes" for every <name>.md in it. The problem is what check-agent.sh says
# (empty when the agent is fine for every agent); the notes are what agent.sh notes says it cannot keep, joined with " | ", e.g.
# "opencode: Task, mcp__x | model: sonnet" (empty when nothing is lost). The description is read from the file itself.
here=$(dirname "$0")
for f in "$1"/*.md; do
  [ -f "$f" ] || continue   # an empty shelf leaves the pattern itself
  n=${f##*/}; n=${n%.md}
  problem=$(sh "$here/check-agent.sh" "$f" | tr '\t' ' ')
  notes=""; [ -n "$problem" ] || notes=$(sh "$here/agent.sh" notes "$f" | awk -F'\t' '{ printf "%s%s: %s", (NR > 1 ? " | " : ""), $1, $2 }')
  printf '%s\t%s\t%s\n' "$n" "$problem" "$notes"
done
