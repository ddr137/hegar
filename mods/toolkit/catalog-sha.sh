#!/bin/sh
# catalog-sha.sh: prints the commit that the main branch of the aitmpl.com catalog's repository (davila7/claude-code-templates) is at now,
# so everything fetched from it afterwards comes from that one commit and cannot change between looking and adding.
GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 ls-remote https://github.com/davila7/claude-code-templates.git refs/heads/main 2>/dev/null | awk 'NR == 1 && $1 ~ /^[0-9a-f]{40}$/ { print $1; ok = 1 } END { exit ok ? 0 : 1 }'
