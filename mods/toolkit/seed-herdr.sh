#!/bin/sh
# seed-herdr.sh <shelf>: puts Herdr's own agent manuals on the shelf as two skills, so agents can learn `hc` and `herdr-app`:
#   herdr-core   <- `hc --skill`          (run, read, message and wait on programs and agents)
#   herdr-window <- `herdr-app --skill`   (change what the person sees: spaces, tabs, panes, layouts)
# The text comes from the installed Herdr, so it always matches its version. They are only put on the shelf (not turned on in
# any project). seeded.txt remembers what was put there: a skill the person deleted is not brought back, and one still on
# the shelf is rewritten only when Herdr's manual changed (an update).
shelf="$1"
[ -n "$shelf" ] || { echo "usage: seed-herdr.sh <shelf>" >&2; exit 2; }
mkdir -p "$shelf/skills"
rec="$shelf/seeded.txt"; [ -f "$rec" ] || : > "$rec"

find_tool() { c=$(command -v "$1" 2>/dev/null); [ -n "$c" ] && { echo "$c"; return; }; [ -x "$HOME/.local/bin/$1" ] && echo "$HOME/.local/bin/$1"; }

seed() { # name tool description
  name="$1"; tool=$(find_tool "$2"); desc="$3"
  [ -n "$tool" ] || return 0
  body=$("$tool" --skill 2>/dev/null) || return 0
  [ -n "$body" ] || return 0
  sum=$(printf '%s' "$body" | cksum | cut -d' ' -f1)
  seen=$(grep "^$name " "$rec" | head -1 | cut -d' ' -f2)
  dir="$shelf/skills/$name"
  if [ -z "$seen" ]; then
    [ -e "$dir" ] && return 0                  # something of the person's own with this name: leave it alone
  else
    [ -d "$dir" ] || return 0                  # deleted on purpose: stay deleted
    [ "$seen" != "$sum" ] || return 0          # same manual as before: nothing to do
  fi
  mkdir -p "$dir"
  { printf -- '---\nname: %s\ndescription: "%s"\n---\n\n' "$name" "$desc"; printf '%s\n' "$body"; } > "$dir/SKILL.md.tmp" && mv "$dir/SKILL.md.tmp" "$dir/SKILL.md"
  grep -v "^$name " "$rec" > "$rec.tmp"; echo "$name $sum" >> "$rec.tmp"; mv "$rec.tmp" "$rec"
}

seed herdr-core hc "Use when you need to run, read, message, wait on or coordinate programs and other coding agents in persistent terminals with the hc CLI (herdr-core): starting an agent, sending it text or keys, waiting until it stops, reading its screen, running commands on other machines. Also use before running long commands such as builds, CI or installs."
seed herdr-window herdr-app "Use when you need to change what the person sees in the Herdr app window with herdr-app: spaces, tabs, panes, layouts, zoom, focus, overlays, mods and themes. To run, read or message programs and agents use herdr-core instead."
