#!/bin/sh
# check-update.sh <owner/repo> <skill> <path it had in the repo> [<skill> <path>]...: where each skill is in the repo now, to see
# whether it changed. Prints "skill<TAB>path<TAB>tree<TAB>commit" (tree: the git id of the skill's folder, which changes when anything
# inside it does), or "skill<TAB>missing" when the repo no longer has it. Only the file list is fetched (a partial clone), never file
# contents. Only a plain owner/repo and plain names are accepted.
set -e
src="$1"; shift
case "$src" in */*/*|*[!A-Za-z0-9._/-]*|"") echo "bad source" >&2; exit 2 ;; esac
case "$src" in */*) ;; *) echo "bad source" >&2; exit 2 ;; esac
[ $# -ge 2 ] && [ $(($# % 2)) -eq 0 ] || { echo "usage: check-update.sh owner/repo skill path [skill path]..." >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export GIT_TERMINAL_PROMPT=0
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=40 clone -q --depth 1 --filter=blob:none --no-checkout "https://github.com/$src.git" "$tmp/repo" 2>"$tmp/err" \
  || { echo "could not reach $src: $(tail -1 "$tmp/err")" >&2; exit 1; }
cd "$tmp/repo"
commit=$(git rev-parse HEAD)
git ls-tree -r --name-only HEAD > "$tmp/files"
while [ $# -ge 2 ]; do
  id="$1"; old="$2"; shift 2
  case "$id" in ""|*[!a-z0-9-]*) printf '%s\tmissing\n' "$id"; continue ;; esac
  path=""
  # still where it was?
  if [ -n "$old" ] && grep -qx -F "$old/SKILL.md" "$tmp/files"; then path="$old"
  # else moved: a folder called <id> that holds SKILL.md
  else path=$(awk -F/ -v id="$id" 'NF >= 2 && $NF == "SKILL.md" && $(NF-1) == id { sub(/\/SKILL\.md$/, ""); print; exit }' "$tmp/files"); fi
  if [ -z "$path" ]; then printf '%s\tmissing\n' "$id"; continue; fi
  printf '%s\t%s\t%s\t%s\n' "$id" "$path" "$(git rev-parse "HEAD:$path")" "$commit"
done
