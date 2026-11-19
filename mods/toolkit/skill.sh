#!/bin/sh
# skill.sh enable|disable <project root> <skills folder> <skill>
# A skill is on in a project when <root>/.opencode/skills/<skill> is a symlink to its folder on the shelf; .agents/skills and
# .claude/skills point at that folder (or, when a project keeps a real folder there, get a link of their own), so Claude Code,
# OpenCode and Antigravity all see it. Toolkit only ever creates or removes links into its own shelf: a real folder, or a link
# that goes anywhere else, is never touched.
set -e
op="$1"; root="$2"; store="$3"; skill="$4"
[ -n "$root" ] && [ -n "$skill" ] && [ -n "$store" ] || { echo "usage: skill.sh enable|disable root store skill" >&2; exit 2; }
[ "$root" != "$HOME" ] && [ "$root" != "/" ] || { echo "not a project folder" >&2; exit 1; }
case "$skill" in */*|.*) echo "bad skill name" >&2; exit 2 ;; esac
dir="$root/.opencode/skills"
ours() { [ -L "$1" ] && case "$(readlink "$1")" in "$store"/*) return 0 ;; esac; return 1; }
case "$op" in
  enable)
    [ -d "$store/$skill" ] || { echo "no such skill on the shelf" >&2; exit 1; }
    if [ -e "$dir/$skill" ] || [ -L "$dir/$skill" ]; then
      ours "$dir/$skill" || { echo "$dir/$skill already exists and is not a Toolkit link" >&2; exit 1; }
    fi
    mkdir -p "$dir" "$root/.agents" "$root/.claude"
    for alias in "$root/.agents/skills" "$root/.claude/skills"; do
      if [ ! -e "$alias" ] && [ ! -L "$alias" ]; then
        ln -s "../.opencode/skills" "$alias"
      elif [ -d "$alias" ] && [ ! -L "$alias" ]; then
        # a real folder of the project's own: the skill gets a link in it too
        if [ -e "$alias/$skill" ] || [ -L "$alias/$skill" ]; then ours "$alias/$skill" || { echo "$alias/$skill already exists and is not a Toolkit link" >&2; exit 1; }; fi
        ln -sfn "$store/$skill" "$alias/$skill"
      fi
    done
    ln -sfn "$store/$skill" "$dir/$skill"
    ;;
  disable)
    for p in "$dir/$skill" "$root/.agents/skills/$skill" "$root/.claude/skills/$skill"; do
      if ours "$p"; then rm -f "$p"; fi
    done
    # Nothing left on: take away the empty folders and alias links enabling made (a folder that holds anything stays).
    if [ -d "$dir" ] && [ -z "$(ls -A "$dir")" ]; then
      rmdir "$dir"
      for alias in "$root/.agents/skills" "$root/.claude/skills"; do
        if [ -L "$alias" ] && [ "$(readlink "$alias")" = "../.opencode/skills" ]; then rm -f "$alias"; fi
      done
    fi
    for d in "$root/.opencode" "$root/.agents" "$root/.claude"; do rmdir "$d" 2>/dev/null || true; done
    ;;
  *) echo "unknown: $op" >&2; exit 2 ;;
esac
