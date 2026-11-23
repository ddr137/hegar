#!/bin/sh
# add-skill.sh <owner/repo> <skill> <skills folder>: fetches the folder holding <skill>/SKILL.md from a GitHub repo into the shelf.
# Only that one folder is downloaded (a partial git clone: the file list first, then the files of the one folder), so a repo of
# hundreds of MB costs a few. The folder is found by its name, else by `name:` in a SKILL.md. Symlinks inside it are dropped.
# The shelf folder is called <skill>, and SKILL.md is made to fit every agent (check-skill.sh): its `name` is set to the folder
# name, and a description is added when it has none; nothing else in it is changed. Only a plain owner/repo and a plain name
# (lowercase letters, digits and single hyphens, up to 64) are accepted.
set -e
here=$(dirname "$0")
src="$1"; id="$2"; dest="$3"
case "$src" in */*/*|*[!A-Za-z0-9._/-]*|"") echo "bad source" >&2; exit 2 ;; esac
case "$src" in */*) ;; *) echo "bad source" >&2; exit 2 ;; esac
case "$id" in ""|*[!a-z0-9-]*|-*|*-|*--*) echo "“$id” is not a name agents accept (lowercase letters, digits and single hyphens)" >&2; exit 2 ;; esac
[ "${#id}" -le 64 ] || { echo "the skill name is longer than 64 characters" >&2; exit 2; }
[ -n "$dest" ] || { echo "no destination" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export GIT_TERMINAL_PROMPT=0
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=40 clone -q --depth 1 --filter=blob:none --no-checkout --sparse "https://github.com/$src.git" "$tmp/repo" 2>"$tmp/err" \
  || { echo "could not fetch $src: $(tail -1 "$tmp/err")" >&2; exit 1; }
cd "$tmp/repo"
# 1. a folder called <id> that holds SKILL.md
dir=$(git ls-tree -r --name-only HEAD | awk -F/ -v id="$id" 'NF >= 2 && $NF == "SKILL.md" && $(NF-1) == id { sub(/\/SKILL\.md$/, ""); print; exit }')
if [ -z "$dir" ]; then
  # 2. else a SKILL.md whose `name:` is <id>: fetch every SKILL.md (small files) and read them
  git sparse-checkout set --no-cone '/**/SKILL.md' >/dev/null 2>&1 && git checkout -q 2>/dev/null || true
  hit=$(grep -rl --include=SKILL.md -E "^name:[[:space:]]*[\"']?$(printf '%s' "$id" | sed 's/[.]/[.]/g')[\"']?[[:space:]]*$" . 2>/dev/null | head -1)
  [ -n "$hit" ] && dir=$(dirname "${hit#./}")
fi
[ -n "$dir" ] || { echo "no SKILL.md for $id in $src" >&2; exit 1; }
commit=$(git rev-parse HEAD); tree=$(git rev-parse "HEAD:$dir")   # where it came from, to find out later whether it changed
git sparse-checkout set --no-cone "/$dir/" >/dev/null 2>&1
git checkout -q 2>/dev/null
[ -f "$dir/SKILL.md" ] || { echo "no SKILL.md for $id in $src" >&2; exit 1; }
find "$dir" -type l -delete
mkdir -p "$tmp/skill"; cp -R "$dir" "$tmp/skill/$id"

# Make SKILL.md fit: name = folder name; a description when there is none.
skill="$tmp/skill/$id"
problem=$(sh "$here/check-skill.sh" "$skill")
if [ -n "$problem" ]; then
  case "$problem" in
    "SKILL.md frontmatter is not closed"*|"no SKILL.md"*|"description is longer"*) echo "$id: $problem" >&2; exit 1 ;;
  esac
  desc=""
  case "$problem" in
    *"no description"*|*"no frontmatter"*)
      # the first sentence-like line of the body (not a heading), else the first heading
      desc=$(awk 'BEGIN{fm=0} NR==1 && /^---[ \t\r]*$/ { fm=1; next } fm==1 { if (/^---[ \t\r]*$/) fm=2; next }
                  { l=$0; head=(l ~ /^[ \t]*#/); gsub(/^[#> \t\r*-]+|[ \t\r]+$/, "", l); if (l == "") next
                    if (head) { if (h == "") h = l } else { print l; done = 1; exit } }
                  END { if (!done) print h }' "$skill/SKILL.md" | tr -d '"\\' | cut -c1-300)
      [ -n "$desc" ] || desc="$id" ;;
  esac
  awk -v id="$id" -v desc="$desc" '
    function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
    NR == 1 {
      if (trim($0) == "---") { infm = 1; print; print "name: " id; if (desc != "") print "description: \"" desc "\""; next }
      print "---"; print "name: " id; print "description: \"" desc "\""; print "---"; print ""; print; next }
    infm && trim($0) == "---" { infm = 0; print; next }
    infm && /^name:/ { dropping = 1; next }
    infm && desc != "" && /^description:/ { dropping = 1; next }
    infm && dropping && /^[ \t]/ { next }
    { dropping = 0; print }' "$skill/SKILL.md" > "$skill/SKILL.md.tmp" && mv "$skill/SKILL.md.tmp" "$skill/SKILL.md"
  problem=$(sh "$here/check-skill.sh" "$skill")
  [ -z "$problem" ] || { echo "$id: $problem" >&2; exit 1; }
fi
mkdir -p "$dest"; rm -rf "$dest/$id"; cp -R "$skill" "$dest/$id"
# the last line says where it came from: commit, the git id of its folder, its path in the repo, and a fingerprint of what is on the shelf
printf 'toolkit-source\t%s\t%s\t%s\t%s\n' "$commit" "$tree" "$dir" "$(sh "$here/fingerprint.sh" "$dest/$id")"
