#!/bin/sh
# gitignore.sh missing|add <project root> <path relative to it>...
# For the links Toolkit makes into the project that point into the person's home folder (so they break on another computer):
#   missing  prints the paths git says it does not ignore yet (nothing when the project is not a git repository or git cannot tell)
#   add      writes them into <root>/.gitignore, one "/<path>" line each, under a comment line; a line that is there is not written again
# Only plain paths (letters, digits, . _ - /) are taken, never one that leaves the project. Nothing else in the file is touched.
op="$1"; root="$2"; shift 2 2>/dev/null
[ -n "$root" ] && [ -d "$root" ] || { echo "no project folder" >&2; exit 2; }
[ -e "$root/.git" ] || { [ "$op" = missing ] && exit 0; echo "not a git project" >&2; exit 3; }
plain() { case "$1" in ""|/*|*..*|*[!A-Za-z0-9._/-]*) return 1 ;; esac; return 0; }
for p in "$@"; do plain "$p" || { echo "not a plain path: $p" >&2; exit 2; }; done
case "$op" in
  missing)
    # exit 1 = git says "not ignored"; 0 = ignored; anything else (not a real repository, say) = cannot tell: say nothing
    for p in "$@"; do git -C "$root" check-ignore -q -- "$p" 2>/dev/null; [ $? -eq 1 ] && printf '%s\n' "$p"; done; exit 0 ;;
  add)
    f="$root/.gitignore"; head='# Toolkit: links into your home folder (they do not work on another computer)'
    [ -f "$f" ] || : > "$f"
    # the file must end with a line break before anything is appended
    if [ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l | tr -d ' ')" = 0 ]; then printf '\n' >> "$f"; fi
    grep -Fxq -- "$head" "$f" || { [ -s "$f" ] && printf '\n' >> "$f"; printf '%s\n' "$head" >> "$f"; }
    for p in "$@"; do grep -Fxq -- "/$p" "$f" || printf '/%s\n' "$p" >> "$f"; done ;;
  *) echo "usage: gitignore.sh missing|add root path..." >&2; exit 2 ;;
esac
