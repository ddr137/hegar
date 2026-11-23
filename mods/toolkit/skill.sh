#!/bin/sh
# skill.sh enable|disable <project root> <skills folder on the shelf> <skill> <agent>...
# agent = claude | opencode | antigravity. Each agent reads a project's skills from its own folder (checked against Claude Code,
# OpenCode and Antigravity themselves):
#   claude -> .claude/skills    opencode -> .opencode/skills    antigravity -> .agents/skills
# A skill is on for Claude and OpenCode when <that folder>/<skill> is a symlink to the skill's folder on the shelf. Antigravity
# does not follow symlinks to skills (not to the folder, not to SKILL.md: checked), so for it the skill is a real copy of the
# shelf folder, marked by a .toolkit-source file holding the shelf path; list-active.sh reports a copy that differs from the
# shelf as stale, and enabling again refreshes it. Toolkit only ever creates or removes what it made (links into its own shelf,
# marked copies): a real folder of the project's own, or a link that goes anywhere else, is never touched, and everything is
# checked before anything is changed. A skill that breaks the agents' naming rules (check-skill.sh) is refused.
set -e
here=$(dirname "$0")
[ $# -ge 5 ] || { echo "usage: skill.sh enable|disable root store skill agent..." >&2; exit 2; }
op="$1"; root="$2"; store="$3"; skill="$4"; shift 4
[ "$root" != "$HOME" ] && [ "$root" != "/" ] || { echo "not a project folder" >&2; exit 1; }
case "$skill" in ""|*/*|.*) echo "bad skill name" >&2; exit 2 ;; esac
folder() { case "$1" in claude) echo .claude/skills ;; opencode) echo .opencode/skills ;; antigravity) echo .agents/skills ;; *) echo "unknown agent: $1" >&2; return 1 ;; esac; }
for a in "$@"; do folder "$a" >/dev/null || exit 2; done
mark=.toolkit-source
ours() { [ -L "$1" ] && case "$(readlink "$1")" in "$store"/*) return 0 ;; esac; return 1; }
copied() { [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$mark" ] && case "$(cat "$1/$mark")" in "$store"/*) return 0 ;; esac; return 1; }
# what Toolkit made for this agent at this path (for Antigravity also the symlink an older Toolkit made, which it cannot read)
mine() { if [ "$1" = antigravity ]; then copied "$2" || ours "$2"; else ours "$2"; fi; }

# An earlier Toolkit made .claude/skills and .agents/skills links to ../.opencode/skills. Each agent has its own folder now,
# so such a link becomes a real folder holding the same entries (links into the shelf, and links to the project's own folders).
unalias() {
  for f in .claude/skills .agents/skills; do
    p="$root/$f"
    if [ -L "$p" ] && [ "$(readlink "$p")" = "../.opencode/skills" ]; then
      rm -f "$p"; mkdir -p "$p"
      for e in "$root/.opencode/skills"/* "$root/.opencode/skills"/.[!.]*; do
        { [ -L "$e" ] || [ -e "$e" ]; } || continue
        n=${e##*/}
        if ours "$e"; then ln -s "$(readlink "$e")" "$p/$n"; else ln -s "../../.opencode/skills/$n" "$p/$n"; fi
      done
    fi
  done
}
# A skills folder that is itself a link would make a change here change another folder too: leave it alone.
plain() {
  d="$root/$(folder "$1")"
  if [ -L "$d" ]; then echo "$d is a link to $(readlink "$d"), so a change there would change that folder too; Toolkit leaves it alone" >&2; return 1; fi
}

case "$op" in
  enable)
    [ -d "$store/$skill" ] || { echo "no such skill on the shelf" >&2; exit 1; }
    problem=$(sh "$here/check-skill.sh" "$store/$skill")
    [ -z "$problem" ] || { echo "$skill: $problem" >&2; exit 1; }
    unalias
    for a in "$@"; do
      plain "$a"
      p="$root/$(folder "$a")/$skill"
      if [ -e "$p" ] || [ -L "$p" ]; then mine "$a" "$p" || { echo "$p already exists and is not something Toolkit made" >&2; exit 1; }; fi
    done
    for a in "$@"; do
      d="$root/$(folder "$a")"; p="$d/$skill"; mkdir -p "$d"
      if [ "$a" = antigravity ]; then
        rm -rf "$p"; cp -R "$store/$skill" "$p"; printf '%s\n' "$store/$skill" > "$p/$mark"
      else
        ln -sfn "$store/$skill" "$p"
      fi
    done
    ;;
  disable)
    unalias
    for a in "$@"; do plain "$a"; done
    for a in "$@"; do
      p="$root/$(folder "$a")/$skill"
      if mine "$a" "$p"; then rm -rf "$p"; fi
    done
    # Nothing left in an agent's folder: take away the empty folders enabling made (one that holds anything stays).
    for a in "$@"; do
      f=$(folder "$a"); d="$root/$f"
      if [ -d "$d" ] && [ -z "$(ls -A "$d")" ]; then rmdir "$d"; fi
      rmdir "$root/${f%/skills}" 2>/dev/null || true
    done
    ;;
  *) echo "unknown: $op" >&2; exit 2 ;;
esac
