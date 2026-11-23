#!/bin/sh
# list-active.sh <project root> <skills folder>: for each agent, what Toolkit put in its skills folder from the shelf, as
# "agent<TAB>name<TAB>state": ok (it is there and current), broken (the shelf no longer has the skill), stale (Antigravity:
# its copy differs from the shelf, or is a symlink, which Antigravity cannot read; enabling again fixes it).
# claude -> .claude/skills, opencode -> .opencode/skills (symlinks into the shelf); antigravity -> .agents/skills (a real copy
# marked with .toolkit-source). See skill.sh. Real folders and links that go anywhere else are the project's own: not listed.
root="$1"; store="$2"
for pair in claude:.claude/skills opencode:.opencode/skills antigravity:.agents/skills; do
  agent=${pair%%:*}; d="$root/${pair#*:}"
  [ -d "$d" ] || continue
  for p in "$d"/* "$d"/.[!.]*; do
    n=${p##*/}
    case "$n" in .*) continue ;; esac
    if [ -L "$p" ]; then
      case "$(readlink "$p")" in "$store"/*) ;; *) continue ;; esac
      if [ ! -e "$p" ]; then state=broken; elif [ "$agent" = antigravity ]; then state=stale; else state=ok; fi
    elif [ "$agent" = antigravity ] && [ -d "$p" ] && [ -f "$p/.toolkit-source" ]; then
      src=$(cat "$p/.toolkit-source")
      case "$src" in "$store"/*) ;; *) continue ;; esac
      if [ ! -d "$src" ]; then state=broken
      elif diff -rq -x .toolkit-source "$p" "$src" >/dev/null 2>&1; then state=ok
      else state=stale; fi
    else
      continue
    fi
    printf '%s\t%s\t%s\n' "$agent" "$n" "$state"
  done
done
