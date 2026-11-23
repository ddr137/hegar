#!/bin/sh
# list-project-agents.sh <project root> <agents folder on the shelf>: the project's OWN agent files (not the ones Toolkit wrote),
# as "agent<TAB>name<TAB>path relative to the project", for Import.
root="$1"; store="$2"
for pair in claude:.claude/agents opencode:.opencode/agents antigravity:.agents/agents; do
  agent=${pair%%:*}; rel=${pair#*:}; d="$root/$rel"
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  for p in "$d"/*.md; do
    [ -f "$p" ] && [ ! -L "$p" ] || continue
    case "$(sed -n 2p "$p")" in "# toolkit: $store/"*) continue ;; esac
    n=${p##*/}; n=${n%.md}
    printf '%s\t%s\t%s\n' "$agent" "$n" "$rel/${p##*/}"
  done
done
