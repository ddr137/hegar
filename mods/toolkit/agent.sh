#!/bin/sh
# agent.sh enable|disable|resync <project root> <agents folder on the shelf> <agent name> <agent>...
# agent.sh gen <agent file on the shelf> <agent>      (prints the file Toolkit writes for that agent)
# agent.sh notes <agent file on the shelf>            (what that file cannot keep for each agent: "opencode<TAB>Task, mcp__x", "model<TAB>sonnet")
# agent = claude | opencode | antigravity. A subagent is one markdown file in the agent's own folder of the project (each one
# checked against Claude Code, OpenCode and Antigravity themselves):
#   claude -> .claude/agents/<name>.md    opencode -> .opencode/agents/<name>.md    antigravity -> .agents/agents/<name>.md
# None of the three follows a link to a shared file the same way (Antigravity does not follow links at all), and the three
# frontmatters differ (OpenCode takes no name and wants mode: subagent; Antigravity wants its own tool names), so each agent gets a real file
# written from the shelf file: name, description, instructions, and the tool limits and model when it has them (see below). Line 2 of such a file is "# toolkit: <shelf file>": a YAML comment every agent ignores,
# and the proof the file is Toolkit's. A file without it is the project's own and is never touched.
#   enable   writes the file for each agent (again if it is there and Toolkit's); refuses if a file of the project's own is there
#   disable  removes the file when it is Toolkit's
#   resync   rewrites the files that are Toolkit's and there, for every agent (after the shelf file changed)
set -e
here=$(dirname "$0")
op="${1:-}"
folder() { case "$1" in claude) echo .claude/agents ;; opencode) echo .opencode/agents ;; antigravity) echo .agents/agents ;; *) echo "unknown agent: $1" >&2; return 1 ;; esac; }

# --- what each agent gets of `tools` and `model` (the shelf file keeps them in Claude's spelling: `tools: Read, Grep`, `model: sonnet`) ---
# Claude      both, as they are.
# OpenCode    `tools` becomes an allow-list in its own map (`"*": false`, then each tool it has a name for set to true: checked with
#             `opencode agent list`, which shows a deny-all rule followed by the allowed ones); `model` is dropped (its ids are provider/model).
# Antigravity `tools` becomes its own names, and is ALWAYS written: its own migration guide says an agent without `tools` gets only a small
#             read-only set. Read/Glob/Grep -> read_file, Edit/MultiEdit -> edit_file, Write -> write_file, Bash -> run_command + manage_task,
#             WebSearch/WebFetch -> search_web. No `tools` at all (= every tool) writes all six. `model` is dropped. It also gets
#             `subagent: true` and `mainAgent: false` so it stays a subagent.
# A grant with no equivalent (an MCP tool, Task for Antigravity, a pattern such as Bash(git:*), which would become "all of bash") is
# dropped, never widened; `agent.sh notes <file>` says which are, per agent.
LIB='
function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
function setup() {
  split("Read:read Glob:glob Grep:grep Edit:edit MultiEdit:edit Write:write Bash:bash WebFetch:webfetch WebSearch:websearch Task:task TodoWrite:todowrite TodoRead:todoread LS:list", p, " ")
  for (i in p) { split(p[i], kv, ":"); oc[kv[1]] = kv[2] }
  split("Read:read_file Glob:read_file Grep:read_file Edit:edit_file MultiEdit:edit_file Write:write_file Bash:run_command,manage_task WebSearch:search_web WebFetch:search_web", q, " ")
  for (i in q) { split(q[i], kv, ":"); ag[kv[1]] = kv[2] }
}
# fills mappedoc / mappedag (lists, in order, without repeats) and dropoc / dropag from the tools text
function map(tools,   n, parts, i, t, k, m, j, seen) {
  setup(); n = split(tools, parts, ",")
  for (i = 1; i <= n; i++) {
    t = trim(parts[i]); gsub(/^\[|\]$/, "", t); t = trim(t); if (t == "") continue
    if (t in oc) { if (!(("o" oc[t]) in seen)) { seen["o" oc[t]] = 1; mappedoc = mappedoc (mappedoc == "" ? "" : ",") oc[t] } } else dropoc = dropoc (dropoc == "" ? "" : ", ") t
    if (t in ag) { m = split(ag[t], k, ","); for (j = 1; j <= m; j++) if (!(("a" k[j]) in seen)) { seen["a" k[j]] = 1; mappedag = mappedag (mappedag == "" ? "" : ", ") k[j] } } else dropag = dropag (dropag == "" ? "" : ", ") t
  }
}
'

if [ "$op" = gen ] || [ "$op" = notes ]; then
  f="$2"; n=${f##*/}; n=${n%.md}
  if [ "$op" = gen ]; then
    a="$3"; folder "$a" >/dev/null || exit 2
  else
    a=all
  fi
  awk -v agent="$a" -v marker="$f" -v name="$n" -v mode="$op" "$LIB"'
    NR == 1 { next }
    !closed && trim($0) == "---" {
      closed = 1
      if (mode == "notes") {
        if (hastools) { map(tools); if (dropoc != "") print "opencode\t" dropoc; if (dropag != "") print "antigravity\t" dropag }
        if (model != "") print "model\t" model
        exit }
      print "---"; print "# toolkit: " marker
      if (agent != "opencode") print "name: " name
      print desc
      if (agent == "claude") { if (hastools) print "tools: " tools; if (model != "") print "model: " model }
      if (agent == "opencode") {
        print "mode: subagent"
        if (hastools) { map(tools); print "tools:"; print "  \"*\": false"; m = split(mappedoc, ts, ","); for (i = 1; i <= m; i++) if (ts[i] != "") print "  " ts[i] ": true" } }
      if (agent == "antigravity") {
        print "subagent: true"; print "mainAgent: false"
        if (hastools) { map(tools); print "tools: [" mappedag "]" } else print "tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]" }
      print "---"
      next }
    !closed {
      if ($0 ~ /^description:/) { desc = $0; sub(/\r$/, "", desc) }
      else if ($0 ~ /^tools:/) { tools = $0; sub(/^tools:[ \t]*/, "", tools); tools = trim(tools); hastools = (tools != "") }
      else if ($0 ~ /^model:/) { model = $0; sub(/^model:[ \t]*/, "", model); model = trim(model) }
      next }
    mode == "gen" { print }' "$f"
  exit 0
fi

case "$op" in
  enable|disable) [ $# -ge 5 ] || { echo "usage: agent.sh enable|disable root store name agent..." >&2; exit 2; } ;;
  resync) [ $# -ge 4 ] || { echo "usage: agent.sh resync root store name" >&2; exit 2; } ;;
  *) echo "usage: agent.sh enable|disable|resync root store name agent..." >&2; exit 2 ;;
esac
root="$2"; store="$3"; name="$4"; shift 4
[ "$root" != "$HOME" ] && [ "$root" != "/" ] || { echo "not a project folder" >&2; exit 1; }
case "$name" in ""|*/*|.*) echo "bad agent name" >&2; exit 2 ;; esac
[ "$op" = resync ] && set -- claude opencode antigravity
for a in "$@"; do folder "$a" >/dev/null || exit 2; done
# the file is Toolkit's: a plain file whose line 2 names a file of this shelf
ours() { [ -f "$1" ] && [ ! -L "$1" ] && case "$(sed -n 2p "$1")" in "# toolkit: $store/"*) return 0 ;; esac; return 1; }
plain() {
  d="$root/$(folder "$1")"
  if [ -L "$d" ]; then echo "$d is a link to $(readlink "$d"), so a change there would change that folder too; Toolkit leaves it alone" >&2; return 1; fi
}
tmp=""; trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT

case "$op" in
  enable|resync)
    src="$store/$name.md"
    [ -f "$src" ] || { echo "no such agent on the shelf" >&2; exit 1; }
    problem=$(sh "$here/check-agent.sh" "$src")
    [ -z "$problem" ] || { echo "$name: $problem" >&2; exit 1; }
    if [ "$op" = resync ]; then
      keep=""; for a in "$@"; do ours "$root/$(folder "$a")/$name.md" && keep="$keep $a"; done
      set -- $keep
      [ $# -gt 0 ] || exit 0
    fi
    for a in "$@"; do
      plain "$a"
      p="$root/$(folder "$a")/$name.md"
      if [ -e "$p" ] || [ -L "$p" ]; then ours "$p" || { echo "$a already has its own agent file for $name ($(folder "$a")/$name.md); Toolkit leaves it alone" >&2; exit 1; }; fi
    done
    for a in "$@"; do
      d="$root/$(folder "$a")"; mkdir -p "$d"
      tmp="$d/.toolkit-$name.tmp"
      sh "$0" gen "$src" "$a" > "$tmp"
      mv "$tmp" "$d/$name.md"; tmp=""
    done
    ;;
  disable)
    for a in "$@"; do plain "$a"; done
    for a in "$@"; do
      p="$root/$(folder "$a")/$name.md"
      if ours "$p"; then rm -f "$p"; fi
    done
    # Nothing left in an agent's folder: take away the empty folders enabling made (one that holds anything stays).
    for a in "$@"; do
      f=$(folder "$a"); d="$root/$f"
      if [ -d "$d" ] && [ -z "$(ls -A "$d")" ]; then rmdir "$d"; fi
      rmdir "$root/${f%/agents}" 2>/dev/null || true
    done
    ;;
  *) echo "usage: agent.sh enable|disable|resync root store name agent..." >&2; exit 2 ;;
esac
