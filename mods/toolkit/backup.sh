#!/bin/sh
# backup.sh <file> <backups folder>: before Toolkit changes or removes a file of a project, keeps a copy of it (when there is one) in
# <backups folder>/<date-time>/<its path with / written as %>. A copy made earlier in the same second is kept (the first one is the
# original). Only the newest 60 date-time folders are kept; nothing outside <backups folder> is ever removed.
f="$1"; root="$2"
[ -n "$f" ] && [ -n "$root" ] || { echo "usage: backup.sh file backups-folder" >&2; exit 2; }
[ -f "$f" ] || exit 0
stamp=$(date +%Y%m%d-%H%M%S); d="$root/$stamp"; name=$(printf %s "$f" | tr / %)
mkdir -p "$d" || exit 1
[ -e "$d/$name" ] || cp -p "$f" "$d/$name" || exit 1
n=0
for x in $(ls -1 "$root" | sort -r); do
  case "$x" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) n=$((n + 1)); [ "$n" -le 60 ] || rm -rf -- "$root/$x" ;;
  esac
done
exit 0
