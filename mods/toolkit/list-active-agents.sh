#!/bin/sh
# list-active-agents.sh <project root> <agents folder on the shelf>: for each agent, the agent files in the project that Toolkit
# wrote from the shelf, as "agent<TAB>name<TAB>state": ok (current), stale (the shelf file changed since), broken (the shelf no
# longer has it). A file without Toolkit's mark on line 2 is the project's own: not listed. See agent.sh.
here=$(dirname "$0")
root="$1"; store="$2"
for pair in claude:.claude/agents opencode:.opencode/agents antigravity:.agents/agents; do
  agent=${pair%%:*}; d="$root/${pair#*:}"
  [ -d "$d" ] || continue
  for p in "$d"/*.md; do
    [ -f "$p" ] && [ ! -L "$p" ] || continue
    case "$(sed -n 2p "$p")" in "# toolkit: $store/"*) ;; *) continue ;; esac
    n=${p##*/}; n=${n%.md}
    src="$store/$n.md"
    if [ ! -f "$src" ]; then state=broken
    elif [ "$(sed -n 2p "$p")" = "# toolkit: $src" ] && [ "$(sh "$here/agent.sh" gen "$src" "$agent"; echo x)" = "$(cat "$p"; echo x)" ]; then state=ok
    else state=stale; fi
    printf '%s\t%s\t%s\n' "$agent" "$n" "$state"
  done
done
