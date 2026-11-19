#!/bin/sh
# list-active.sh <project root> <skills folder>: the links in <root>/.opencode/skills that go into the shelf, as
# "name<TAB>ok" (the skill is there) or "name<TAB>broken" (the shelf no longer has it). Real folders and links that go
# anywhere else are the project's own and are not listed.
d="$1/.opencode/skills"; store="$2"
[ -d "$d" ] || exit 0
for p in "$d"/* "$d"/.[!.]*; do
  [ -L "$p" ] || continue
  n=${p##*/}
  case "$n" in .*) continue ;; esac
  case "$(readlink "$p")" in "$store"/*) ;; *) continue ;; esac
  if [ -e "$p" ]; then printf '%s\tok\n' "$n"; else printf '%s\tbroken\n' "$n"; fi
done
