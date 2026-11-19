#!/bin/sh
# remove-skill.sh <skills folder> <skill>: erases <skills folder>/<skill>. Only a real folder sitting directly in the
# shelf's skills folder (.../toolkit/skills) is removed; nothing else is.
set -e
store="$1"; name="$2"
case "$store" in */toolkit/skills) ;; *) echo "not the shelf" >&2; exit 2 ;; esac
case "$name" in ""|*/*|.*) echo "bad skill name" >&2; exit 2 ;; esac
[ -d "$store" ] || { echo "no shelf" >&2; exit 1; }
if [ -d "$store/$name" ] && [ ! -L "$store/$name" ]; then rm -rf -- "$store/$name"; else echo "$name is not on the shelf" >&2; exit 1; fi
