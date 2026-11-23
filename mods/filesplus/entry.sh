#!/bin/sh
# entry.sh check|edit|count|trash|remove|rename <folder> <path inside it> [new name]
# entry.sh create-file|create-dir <folder> <path of the folder to make it in, "" for <folder> itself> <name>
# What the Files panel does to one file or folder of the folder it shows. Everything runs on this computer only.
# A path must be a plain relative path (no leading /, no .., nothing in .git) and the entry's own folder must really sit
# inside <folder> once links are resolved, so a folder that is a link out of the project can never be reached through it.
# A new or new name is one plain name (no /, no line break, not . or .., not .git, no space at either end, at most 255 bytes).
# Nothing is ever overwritten: a name that is taken is refused.
# Exit codes: 0 done, 2 not a path inside the folder, 3 it no longer exists, 4 reached through a link that leaves the folder,
# 5 Trash is on another disk, 6 no Trash here, 7 read-only, 8 not a regular file, 9 the name is taken, 10 not a usable name,
# 11 the folder to create in is gone, anything else: it failed (message on stderr).
set -u
cmd="${1:-}"; root="${2:-}"; rel="${3:-}"

bad_path() {
  case "$1" in
    /*|*/|.|..|../*|*/..|*/../*|*//*|.git|.git/*|*/.git|*/.git/*) return 0 ;;
  esac
  return 1
}
usable_name() {
  case "$1" in
    ""|.|..|.git|*/*|" "*|*" ") return 1 ;;
  esac
  # (a command substitution drops a trailing newline, so the characters are built with a mark after them)
  nl=$(printf '\n_'); nl=${nl%_}; cr=$(printf '\r_'); cr=${cr%_}
  case "$1" in *"$nl"*|*"$cr"*) return 1 ;; esac
  [ "$(printf %s "$1" | wc -c | tr -d ' ')" -le 255 ]
}
real_root=$(cd "$root" 2>/dev/null && pwd -P) || { echo "the folder is not available" >&2; exit 2; }
inside() { case "$1/" in "$real_root"/*) return 0 ;; esac; return 1; }

case "$cmd" in
  create-file|create-dir)
    name="${4:-}"
    usable_name "$name" || { echo "not a usable name" >&2; exit 10; }
    if [ -n "$rel" ]; then bad_path "$rel" && { echo "not a path inside this folder" >&2; exit 2; }; fi
    d="$root${rel:+/$rel}"
    [ -d "$d" ] || { echo "that folder no longer exists" >&2; exit 11; }
    real_d=$(cd "$d" 2>/dev/null && pwd -P) || exit 11
    inside "$real_d" || { echo "it is reached through a link that leaves this folder" >&2; exit 4; }
    p="$d/$name"
    if [ -e "$p" ] || [ -L "$p" ]; then echo "the name is taken" >&2; exit 9; fi
    if [ "$cmd" = create-dir ]; then
      mkdir -- "$p" || { { [ -e "$p" ] || [ -L "$p" ]; } && exit 9; exit 1; }
    else
      ( set -C; : > "$p" ) 2>/dev/null || { { [ -e "$p" ] || [ -L "$p" ]; } && exit 9; exit 1; }
    fi
    exit 0 ;;
esac

bad_path "$rel" && { echo "not a path inside this folder" >&2; exit 2; }
[ -n "$rel" ] || { echo "not a path inside this folder" >&2; exit 2; }
p="$root/$rel"
[ -e "$p" ] || [ -L "$p" ] || { echo "it no longer exists" >&2; exit 3; }
real_parent=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || { echo "it no longer exists" >&2; exit 3; }
inside "$real_parent" || { echo "it is reached through a link that leaves this folder" >&2; exit 4; }

inode() { if [ "$(uname)" = Darwin ]; then stat -f %i "$1"; else stat -c %i "$1"; fi; }

case "$cmd" in
  check) exit 0 ;;
  edit)
    # a link is fine to edit (the file it points to changes); say where it points
    [ -L "$p" ] && printf 'link\t%s\n' "$(readlink "$p")"
    [ -f "$p" ] || { echo "not a regular file" >&2; exit 8; }
    [ -w "$p" ] || { echo "read-only" >&2; exit 7; }
    exit 0 ;;
  rename)
    new="${4:-}"
    usable_name "$new" || { echo "not a usable name" >&2; exit 10; }
    old=$(basename "$p")
    [ "$old" = "$new" ] && exit 0
    dest="$(dirname "$p")/$new"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      # the same entry under another capitalisation (a disk that ignores case) is a rename; anything else is a clash
      lower_old=$(printf %s "$old" | tr '[:upper:]' '[:lower:]'); lower_new=$(printf %s "$new" | tr '[:upper:]' '[:lower:]')
      if [ "$lower_old" = "$lower_new" ] && [ "$(inode "$p")" = "$(inode "$dest")" ]; then :; else echo "the name is taken" >&2; exit 9; fi
    fi
    mv -- "$p" "$dest" || exit 1 ;;
  count)
    if [ -d "$p" ] && [ ! -L "$p" ]; then
      n=$(find "$p" 2>/dev/null | head -n 10001 | wc -l | tr -d ' ')
      echo $((n - 1))
    else
      echo 1
    fi ;;
  trash)
    case "$(uname)" in
      Darwin)
        t="$HOME/.Trash"; [ -d "$t" ] || { echo "no Trash folder" >&2; exit 6; }
        [ "$(stat -f %d "$p")" = "$(stat -f %d "$t")" ] || { echo "the Trash is on another disk" >&2; exit 5; }
        name=$(basename "$p"); dest="$t/$name"; stamp=$(date +%H.%M.%S); i=0
        while [ -e "$dest" ] || [ -L "$dest" ]; do i=$((i + 1)); dest="$t/$name $stamp${i:+ $i}"; done
        mv -- "$p" "$dest" || exit 1 ;;
      Linux)
        if command -v gio >/dev/null 2>&1; then gio trash -- "$p" || exit 1
        elif command -v trash-put >/dev/null 2>&1; then trash-put -- "$p" || exit 1
        else echo "no trash command (gio or trash-put)" >&2; exit 6; fi ;;
      *) echo "no Trash here" >&2; exit 6 ;;
    esac ;;
  remove) rm -rf -- "$p" || exit 1 ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
