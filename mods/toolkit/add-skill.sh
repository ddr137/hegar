#!/bin/sh
# add-skill.sh <owner/repo> <skill> <skills folder>: downloads a GitHub repo and copies the folder holding <skill>/SKILL.md
# (found by folder name, else by `name:` in the SKILL.md) into the shelf. Only a plain owner/repo and a plain name are accepted.
set -e
src="$1"; id="$2"; dest="$3"
case "$src" in */*/*|*[!A-Za-z0-9._/-]*|"") echo "bad source" >&2; exit 2 ;; esac
case "$src" in */*) ;; *) echo "bad source" >&2; exit 2 ;; esac
case "$id" in */*|.*|"") echo "bad skill name" >&2; exit 2 ;; esac
[ -n "$dest" ] || { echo "no destination" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL -m 120 "https://codeload.github.com/$src/tar.gz/HEAD" | tar -xz -C "$tmp"
found=$(find "$tmp" -type f -path "*/$id/SKILL.md" | head -1)
if [ -z "$found" ]; then found=$(grep -rl --include=SKILL.md -E "^name:[[:space:]]*[\"']?$id[\"']?[[:space:]]*$" "$tmp" | head -1); fi
[ -n "$found" ] || { echo "no SKILL.md for $id in $src" >&2; exit 1; }
mkdir -p "$dest"; rm -rf "$dest/$id"; cp -R "$(dirname "$found")" "$dest/$id"
