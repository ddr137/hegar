#!/bin/sh
# fingerprint.sh <folder>: one short hash of every file in the folder (its path and content; a link counts by where it points),
# to tell whether a skill was edited after it was put on the shelf. Prints nothing and fails when there is no such folder.
d="$1"; [ -d "$d" ] || exit 1
digest() { if command -v shasum >/dev/null 2>&1; then shasum -a 256; elif command -v sha256sum >/dev/null 2>&1; then sha256sum; else cksum; fi; }
( cd "$d" && find . \( -type f -o -type l \) | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf 'L %s -> %s\n' "$f" "$(readlink "$f")"; else printf 'F %s %s\n' "$f" "$(digest < "$f" | cut -d' ' -f1)"; fi
  done ) | digest | cut -d' ' -f1 | cut -c1-16
